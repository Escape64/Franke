// Живой рендер markdown в духе Obsidian: редактор и просмотр — одно окно.
// Синтаксические маркеры (#, **, `, >, ссылки) ПРЯЧУТСЯ декорациями везде,
// кроме строк, где стоит курсор/выделение, — там показывается сырой markdown
// для правки. Стили контента (размеры заголовков, жирный, код) вешаются
// классами через HighlightStyle, сами классы описаны в style.css.
//
// Дерево разбора даёт @codemirror/lang-markdown (база markdownLanguage —
// CommonMark + GFM: зачёркивание, чекбоксы задач). Таблицы и картинки пока
// не рендерим — только стилизуем (медиа-блобы — отдельный этап).
import {
  Decoration,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  type DecorationSet
} from '@codemirror/view'
import { EditorState, type Range } from '@codemirror/state'
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

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
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

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
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
    })
  }

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

const livePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildDecorations(u.view)
      }
    }
  },
  { decorations: (v) => v.decorations }
)

export function liveMarkdown() {
  return [livePlugin, syntaxHighlighting(mdHighlight)]
}
