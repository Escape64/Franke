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

  private editCell(e: MouseEvent, view: EditorView, rowInLines: number, cellStart: number) {
    e.preventDefault()
    const firstNo = view.state.doc.lineAt(this.blockStart).number
    const line = view.state.doc.line(firstNo + rowInLines)
    view.dispatch({ selection: { anchor: Math.min(line.from + cellStart, line.to) } })
    view.focus()
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
    const wrap = document.createElement('div')
    wrap.className = 'cm-table-wrap'

    const rowBox = document.createElement('div')
    rowBox.className = 'cm-table-row'
    const table = document.createElement('table')
    table.className = 'cm-md-table'

    const thead = document.createElement('thead')
    const htr = document.createElement('tr')
    for (const c of rows[0] ?? []) {
      const th = document.createElement('th')
      th.textContent = c.text
      th.onmousedown = (e) => this.editCell(e, view, 0, c.start)
      htr.appendChild(th)
    }
    thead.appendChild(htr)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    for (let r = 2; r < rows.length; r++) {
      const tr = document.createElement('tr')
      for (const c of rows[r]) {
        const td = document.createElement('td')
        td.textContent = c.text
        td.onmousedown = (e) => this.editCell(e, view, r, c.start)
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    rowBox.appendChild(table)

    if (!view.state.readOnly) {
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

    if (!view.state.readOnly) {
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
    return false
  }
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

  // Проход по таблицам: неактивные (без курсора внутри) заменяем на HTML-виджет
  // блочной декорацией; их узлы в основном обходе пропускаем, чтобы внутренние
  // маркеры ячеек не конфликтовали с блочной заменой.
  const tableSkip: { from: number; to: number }[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return
      if (isActive(node.from, node.to)) return
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
