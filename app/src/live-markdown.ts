// Живой рендер markdown в духе Obsidian: редактор и просмотр — одно окно.
// Синтаксические маркеры (#, **, `, >, ссылки) ПРЯЧУТСЯ декорациями везде,
// кроме строк, где стоит курсор/выделение, — там показывается сырой markdown
// для правки. Стили контента (размеры заголовков, жирный, код) вешаются
// классами через HighlightStyle, сами классы описаны в style.css.
//
// Дерево разбора даёт @codemirror/lang-markdown (база markdownLanguage —
// CommonMark + GFM: зачёркивание, чекбоксы задач). Таблицы и картинки пока
// не рендерим — только стилизуем (медиа-блобы — отдельный этап).
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { EditorState, StateField, type Range } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { tags } from '@lezer/highlight'

// --- Стили контента (классы — в style.css) ---
const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, class: 'cm-md-h1' },
  { tag: tags.heading2, class: 'cm-md-h2' },
  { tag: tags.heading3, class: 'cm-md-h3' },
  { tag: tags.heading4, class: 'cm-md-h4' },
  { tag: tags.heading5, class: 'cm-md-h5' },
  { tag: tags.heading6, class: 'cm-md-h6' },
  { tag: tags.strong, class: 'cm-md-strong' },
  { tag: tags.emphasis, class: 'cm-md-em' },
  { tag: tags.strikethrough, class: 'cm-md-strike' },
  { tag: tags.link, class: 'cm-md-link' },
  { tag: tags.url, class: 'cm-md-url' },
  { tag: tags.monospace, class: 'cm-md-mono' },
  // Видимые маркеры (на активной строке) — приглушённые
  { tag: tags.processingInstruction, class: 'cm-md-mark' },
  { tag: tags.contentSeparator, class: 'cm-md-mark' }
])

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = 'cm-list-bullet'
    s.textContent = '•'
    return s
  }
  eq(): boolean {
    return true
  }
}

class HrWidget extends WidgetType {
  toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = 'cm-hr'
    return s
  }
  eq(): boolean {
    return true
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    private checked: boolean,
    private from: number,
    private to: number
  ) {
    super()
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.from === this.from && other.to === this.to
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-task-checkbox'
    box.checked = this.checked
    // mousedown не отдаём редактору (иначе клик просто ставит курсор)
    box.onmousedown = (e) => e.preventDefault()
    box.onclick = (e) => {
      e.preventDefault()
      if (view.state.facet(EditorState.readOnly)) return
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' }
      })
    }
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}

// --- Таблицы ---
// GFM-таблица (markdown с `|`) рендерится в настоящий <table>, когда курсор вне
// её строк; клик в ячейку возвращает курсор в markdown (строки становятся
// «активными» → сырой вид), а кнопки «+» под и справа добавляют строку/столбец.
interface Cell {
  text: string
  start: number // смещение содержимого ячейки внутри строки
}

function parseCells(lineText: string): Cell[] {
  const cells: Cell[] = []
  let i = 0
  if (lineText[i] === '|') i++
  let cellStart = i
  for (; i <= lineText.length; i++) {
    if (i === lineText.length || lineText[i] === '|') {
      const raw = lineText.slice(cellStart, i)
      const trimmedStart = cellStart + (raw.length - raw.trimStart().length)
      cells.push({ text: raw.trim(), start: trimmedStart })
      cellStart = i + 1
      if (i === lineText.length) break
    }
  }
  // Хвостовая ячейка от завершающего `|` — лишняя
  if (cells.length && lineText.trimEnd().endsWith('|')) cells.pop()
  return cells
}

function isDelimiterRow(text: string): boolean {
  const t = text.trim()
  return /^[\s|:-]+$/.test(t) && t.includes('-')
}

function buildRow(cells: string[]): string {
  return '| ' + cells.join(' | ') + ' |'
}

/** Строки таблицы начиная с blockStart (все подряд содержат `|`). */
function tableLines(state: EditorView['state'], blockStart: number) {
  const start = state.doc.lineAt(blockStart).number
  const out = []
  for (let n = start; n <= state.doc.lines; n++) {
    const l = state.doc.line(n)
    if (l.text.includes('|')) out.push(l)
    else break
  }
  return out
}

class TableWidget extends WidgetType {
  constructor(
    private blockStart: number,
    private raw: string
  ) {
    super()
  }
  eq(o: TableWidget): boolean {
    return o.blockStart === this.blockStart && o.raw === this.raw
  }

  // Запись одной ячейки в markdown. Позиции берём из живого состояния.
  private writeCell(view: EditorView, rowInLines: number, cellIndex: number, value: string) {
    const firstNo = view.state.doc.lineAt(this.blockStart).number
    const lineNo = firstNo + rowInLines
    if (lineNo > view.state.doc.lines) return
    const line = view.state.doc.line(lineNo)
    const c = parseCells(line.text)[cellIndex]
    if (!c) return
    const safe = value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
    if (safe === c.text) return
    view.dispatch({
      changes: { from: line.from + c.start, to: line.from + c.start + c.text.length, insert: safe }
    })
  }

  private addRow(view: EditorView) {
    const lines = tableLines(view.state, this.blockStart)
    if (!lines.length) return
    const cols = parseCells(lines[0].text).length
    const last = lines[lines.length - 1]
    view.dispatch({ changes: { from: last.to, insert: '\n' + buildRow(Array(cols).fill('')) } })
    view.focus()
  }

  private addColumn(view: EditorView) {
    const lines = tableLines(view.state, this.blockStart)
    if (!lines.length) return
    const changes = lines.map((l) => {
      const cells = parseCells(l.text).map((c) => c.text)
      cells.push(isDelimiterRow(l.text) ? '---' : '')
      return { from: l.from, to: l.to, insert: buildRow(cells) }
    })
    view.dispatch({ changes })
    view.focus()
  }

  toDOM(view: EditorView): HTMLElement {
    const rows = this.raw.split('\n').map((l) => parseCells(l))
    const editable = !view.state.readOnly
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-wrap'
    wrap.contentEditable = 'false'
    // mouseup/click внутри таблицы не должны доходить до CM — иначе он вернёт
    // фокус себе и закроет плавающий редактор ячейки. Кнопки «+» и ячейки свои
    // обработчики (в target-фазе) уже отработали к моменту всплытия сюда.
    wrap.addEventListener('mouseup', (e) => e.stopPropagation())
    wrap.addEventListener('click', (e) => e.stopPropagation())

    const rowBox = document.createElement('div')
    rowBox.className = 'cm-table-row'
    const table = document.createElement('table')
    table.className = 'cm-md-table'

    // Ячейка нередактируема на месте (иначе поле ввода воюет с фокусом CM).
    // По клику над ячейкой всплывает плавающий редактор ВНЕ CM (см. openCellEditor).
    const makeCell = (tag: 'th' | 'td', rowInLines: number, cellIndex: number, text: string) => {
      const cellEl = document.createElement(tag)
      cellEl.textContent = text
      if (editable) {
        cellEl.classList.add('cm-td-edit')
        cellEl.dataset.cell = `${rowInLines}:${cellIndex}`
        cellEl.addEventListener('mousedown', (e) => {
          e.preventDefault()
          e.stopPropagation()
          openCellEditor(view, this.blockStart, rowInLines, cellIndex, cellEl.getBoundingClientRect(), (v) =>
            this.writeCell(view, rowInLines, cellIndex, v)
          )
        })
      }
      return cellEl
    }

    const thead = document.createElement('thead')
    const htr = document.createElement('tr')
    ;(rows[0] ?? []).forEach((c, ci) => htr.appendChild(makeCell('th', 0, ci, c.text)))
    thead.appendChild(htr)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    for (let r = 2; r < rows.length; r++) {
      const tr = document.createElement('tr')
      rows[r].forEach((c, ci) => tr.appendChild(makeCell('td', r, ci, c.text)))
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    rowBox.appendChild(table)

    if (editable) {
      const addCol = document.createElement('button')
      addCol.className = 'cm-table-addcol'
      addCol.textContent = '+'
      addCol.title = 'Добавить столбец справа'
      addCol.onmousedown = (e) => {
        e.preventDefault()
        this.addColumn(view)
      }
      rowBox.appendChild(addCol)
    }
    wrap.appendChild(rowBox)

    if (editable) {
      const addRow = document.createElement('button')
      addRow.className = 'cm-table-addrow'
      addRow.textContent = '+'
      addRow.title = 'Добавить строку снизу'
      addRow.onmousedown = (e) => {
        e.preventDefault()
        this.addRow(view)
      }
      wrap.appendChild(addRow)
    }
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

// Открытый сейчас редактор ячейки — чтобы зафиксировать его перед открытием
// другого (клик в соседнюю ячейку не должен терять введённое).
let activeCellCommit: (() => void) | null = null

// Плавающий редактор ячейки: поле ввода в document.body поверх ячейки. Живёт
// ВНЕ contentDOM редактора, поэтому CM не отбирает у него фокус. Пишет значение
// в markdown по Enter/blur/Tab и при открытии другой ячейки; растёт по вводу.
function openCellEditor(
  view: EditorView,
  blockStart: number,
  rowInLines: number,
  cellIndex: number,
  rect: DOMRect,
  write: (value: string) => void
) {
  activeCellCommit?.() // сохранить ранее открытую ячейку, если была

  // Текущий текст ячейки читаем из живого документа (после возможной пересборки).
  const lineNo = view.state.doc.lineAt(blockStart).number + rowInLines
  const initial =
    lineNo <= view.state.doc.lines ? (parseCells(view.state.doc.line(lineNo).text)[cellIndex]?.text ?? '') : ''

  const input = document.createElement('input')
  input.className = 'cm-cell-editor'
  input.value = initial
  input.style.left = `${rect.left}px`
  input.style.top = `${rect.top}px`
  input.style.height = `${rect.height}px`

  // Автоширина: не уже ячейки и не уже удобного минимума, дальше растёт по тексту.
  const grow = () => {
    input.style.width = '0'
    input.style.width = `${Math.min(560, Math.max(140, rect.width, input.scrollWidth + 4))}px`
  }
  input.addEventListener('input', grow)

  let done = false
  const finish = (commit: boolean, moveTo?: { row: number; col: number }) => {
    if (done) return
    done = true
    if (activeCellCommit === commitThis) activeCellCommit = null
    input.remove()
    if (commit) write(input.value)
    if (moveTo) {
      // После записи виджет пересобрался — ищем соседнюю ячейку в новом DOM.
      requestAnimationFrame(() => {
        const next = view.dom.querySelector<HTMLElement>(
          `.cm-td-edit[data-cell="${moveTo.row}:${moveTo.col}"]`
        )
        next?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      })
    } else if (commit) {
      view.focus()
    }
  }
  const commitThis = () => finish(true)
  activeCellCommit = commitThis

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      finish(true, { row: rowInLines, col: cellIndex + (e.shiftKey ? -1 : 1) })
    }
  })
  document.body.appendChild(input)
  grow()
  // Снимаем фокус с contentDOM — иначе CM по selectionchange вернёт выделение
  // себе и закроет редактор.
  view.contentDOM.blur()
  input.focus()
  input.select()
  // Со следующего кадра: (1) если предыдущая ячейка при сохранении расширила
  // таблицу, переносим редактор на актуальную позицию ячейки; (2) отбиваем
  // транзитный перехват фокуса; (3) вешаем blur→commit (клик мимо сохраняет).
  requestAnimationFrame(() => {
    if (done) return
    const live = view.dom.querySelector<HTMLElement>(
      `.cm-td-edit[data-cell="${rowInLines}:${cellIndex}"]`
    )
    if (live) {
      const r = live.getBoundingClientRect()
      input.style.left = `${r.left}px`
      input.style.top = `${r.top}px`
      input.style.height = `${r.height}px`
      if (parseFloat(input.style.width) < r.width) input.style.width = `${r.width}px`
    }
    if (document.activeElement !== input) input.focus()
    input.addEventListener('blur', () => finish(true))
  })
}

// Обходим весь документ (не только видимую область): блочные декорации таблиц
// должны быть известны редактору ДО раскладки, поэтому живут в StateField, а он
// не имеет доступа к вьюпорту. Для заметок это дёшево.
function buildDecorations(state: EditorState): DecorationSet {
  const doc = state.doc

  // Строки, затронутые курсором/выделением: на них markdown показывается сырым.
  const activeLines = new Set<number>()
  for (const r of state.selection.ranges) {
    const from = doc.lineAt(r.from).number
    const to = doc.lineAt(r.to).number
    for (let n = from; n <= to; n++) activeLines.add(n)
  }
  const isActive = (from: number, to: number): boolean => {
    const a = doc.lineAt(from).number
    const b = doc.lineAt(Math.min(to, doc.length)).number
    for (let n = a; n <= b; n++) if (activeLines.has(n)) return true
    return false
  }

  const decos: Range<Decoration>[] = []
  const hide = (from: number, to: number) => {
    if (to > from) decos.push(Decoration.replace({}).range(from, to))
  }
  // Маркер + один пробел после него (заголовки, цитаты)
  const hideWithSpace = (from: number, to: number) => {
    hide(from, doc.sliceString(to, to + 1) === ' ' ? to + 1 : to)
  }

  // Буллеты и чекбоксы координируются после обхода: у строки-задачи маркер
  // списка прячется совсем, у обычного пункта заменяется на «•».
  const bulletMarks: { from: number; to: number; line: number }[] = []
  const taskLines = new Set<number>()
  const quoteLines = new Set<number>()
  const codeLines = new Set<number>()
  // Активность объемлющего элемента для вложенных маркеров (забор кода, ссылка)
  let fenceActive = false
  let linkActive = false

  // Проход по таблицам: ВСЕГДА заменяем на HTML-виджет с редактируемыми
  // ячейками (таблица не «рассыпается» в raw при вводе — правка идёт прямо в
  // ячейках). Узлы таблицы в основном обходе пропускаем (tableSkip), чтобы
  // внутренние маркеры ячеек не конфликтовали с блочной заменой.
  const tableSkip: { from: number; to: number }[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return
      const firstLine = doc.lineAt(node.from)
      const end = Math.min(node.to, doc.length)
      let lastLine = doc.lineAt(end)
      if (lastLine.from === end && end > node.from) lastLine = doc.lineAt(end - 1)
      const raw = doc.sliceString(firstLine.from, lastLine.to)
      decos.push(
        Decoration.replace({
          widget: new TableWidget(firstLine.from, raw),
          block: true
        }).range(firstLine.from, lastLine.to)
      )
      tableSkip.push({ from: firstLine.from, to: lastLine.to })
    }
  })

  syntaxTree(state).iterate({
    enter: (node) => {
      {
        for (const t of tableSkip) if (node.from >= t.from && node.from < t.to) return false
        switch (node.name) {
          case 'HeaderMark':
            if (!isActive(node.from, node.to)) hideWithSpace(node.from, node.to)
            break
          case 'EmphasisMark':
          case 'StrikethroughMark':
            if (!isActive(node.from, node.to)) hide(node.from, node.to)
            break
          case 'FencedCode': {
            fenceActive = isActive(node.from, node.to)
            const first = doc.lineAt(node.from).number
            const last = doc.lineAt(node.to).number
            for (let n = first; n <= last; n++) {
              if (codeLines.has(n)) continue
              codeLines.add(n)
              decos.push(
                Decoration.line({ class: 'cm-codeblock-line' }).range(doc.line(n).from)
              )
            }
            break
          }
          case 'CodeMark': {
            const parent = node.node.parent?.name
            if (parent === 'FencedCode') {
              if (!fenceActive) hide(node.from, node.to)
            } else if (!isActive(node.from, node.to)) {
              hide(node.from, node.to)
            }
            break
          }
          case 'CodeInfo':
            if (!fenceActive) hide(node.from, node.to)
            break
          case 'Blockquote': {
            const first = doc.lineAt(node.from).number
            const last = doc.lineAt(node.to).number
            for (let n = first; n <= last; n++) {
              if (quoteLines.has(n)) continue
              quoteLines.add(n)
              decos.push(Decoration.line({ class: 'cm-quote-line' }).range(doc.line(n).from))
            }
            break
          }
          case 'QuoteMark':
            if (!isActive(node.from, node.to)) hideWithSpace(node.from, node.to)
            break
          case 'Link':
          case 'Image':
            linkActive = isActive(node.from, node.to)
            break
          case 'LinkMark':
          case 'URL':
            if (!linkActive) hide(node.from, node.to)
            break
          case 'ListMark': {
            // Только маркеры маркированных списков; нумерация остаётся как есть.
            const listType = node.node.parent?.parent?.name
            if (listType === 'BulletList') {
              bulletMarks.push({
                from: node.from,
                to: node.to,
                line: doc.lineAt(node.from).number
              })
            }
            break
          }
          case 'TaskMarker': {
            const line = doc.lineAt(node.from).number
            taskLines.add(line)
            if (!activeLines.has(line)) {
              const checked = doc.sliceString(node.from, node.to).toLowerCase().includes('x')
              decos.push(
                Decoration.replace({
                  widget: new CheckboxWidget(checked, node.from, node.to)
                }).range(node.from, node.to)
              )
            }
            break
          }
          case 'HorizontalRule':
            if (!isActive(node.from, node.to)) {
              decos.push(
                Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to)
              )
            }
            break
        }
      }
    }
  })

  for (const m of bulletMarks) {
    if (activeLines.has(m.line)) continue
    if (taskLines.has(m.line)) {
      // Строка-задача: чекбокс уже вместо [x], бублик-маркер прячем вместе
      // с пробелом перед чекбоксом.
      hideWithSpace(m.from, m.to)
    } else {
      decos.push(
        Decoration.replace({ widget: new BulletWidget() }).range(m.from, m.to)
      )
    }
  }

  return Decoration.set(decos, true)
}

// StateField (не ViewPlugin): блочные декорации таблиц должны быть известны до
// раскладки. Пересчитываем на любое изменение текста или выделения.
const liveField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state)
  },
  update(deco, tr) {
    if (tr.docChanged || tr.selection) return buildDecorations(tr.state)
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f)
})

export function liveMarkdown() {
  return [liveField, syntaxHighlighting(mdHighlight)]
}
