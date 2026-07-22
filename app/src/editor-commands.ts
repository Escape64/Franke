// Команды форматирования для редактора — правят текст как markdown, а живой
// рендер (live-markdown.ts) сразу показывает результат. Все команды уважают
// EditorState.readOnly (читатель/комментатор текст не меняют).
import { EditorView, type KeyBinding } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'

/** Обернуть выделение маркером (жирный/курсив/код). Повторный вызов снимает. */
export function wrapSelection(view: EditorView, before: string, after = before): boolean {
  if (view.state.readOnly) return false
  const { state } = view
  view.dispatch(
    state.changeByRange((range) => {
      const selected = state.sliceDoc(range.from, range.to)
      // Маркеры внутри выделения → снять
      if (
        selected.length >= before.length + after.length &&
        selected.startsWith(before) &&
        selected.endsWith(after)
      ) {
        const inner = selected.slice(before.length, selected.length - after.length)
        return {
          changes: { from: range.from, to: range.to, insert: inner },
          range: EditorSelection.range(range.from, range.from + inner.length)
        }
      }
      // Маркеры сразу за пределами выделения → снять
      const pre = state.sliceDoc(Math.max(0, range.from - before.length), range.from)
      const post = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + after.length))
      if (pre === before && post === after) {
        return {
          changes: [
            { from: range.from - before.length, to: range.from },
            { from: range.to, to: range.to + after.length }
          ],
          range: EditorSelection.range(range.from - before.length, range.to - before.length)
        }
      }
      // Иначе — обернуть; пустое выделение оставит курсор между маркерами
      return {
        changes: [
          { from: range.from, insert: before },
          { from: range.to, insert: after }
        ],
        range: EditorSelection.range(range.from + before.length, range.to + before.length)
      }
    })
  )
  view.focus()
  return true
}

function selectedLines(view: EditorView) {
  const { state } = view
  const first = state.doc.lineAt(state.selection.main.from).number
  const last = state.doc.lineAt(state.selection.main.to).number
  const lines = []
  for (let n = first; n <= last; n++) lines.push(state.doc.line(n))
  return lines
}

/** Тумблер строчного префикса (список, задача, цитата) для всех строк выделения. */
export function toggleLinePrefix(view: EditorView, prefix: string): boolean {
  if (view.state.readOnly) return false
  const lines = selectedLines(view)
  const allHave = lines.every((l) => l.text.startsWith(prefix))
  const changes = lines.map((l) =>
    allHave ? { from: l.from, to: l.from + prefix.length } : { from: l.from, insert: prefix }
  )
  view.dispatch({ changes })
  view.focus()
  return true
}

/** Заголовок уровня 1–6; level=0 убирает заголовок. Заменяет уже стоящий. */
export function setHeading(view: EditorView, level: number): boolean {
  if (view.state.readOnly) return false
  const changes = selectedLines(view).map((l) => {
    const m = l.text.match(/^(#{1,6}\s+)/)
    const stripLen = m ? m[1].length : 0
    const insert = level > 0 ? '#'.repeat(level) + ' ' : ''
    return { from: l.from, to: l.from + stripLen, insert }
  })
  view.dispatch({ changes })
  view.focus()
  return true
}

export function insertLink(view: EditorView): boolean {
  if (view.state.readOnly) return false
  const r = view.state.selection.main
  const label = view.state.sliceDoc(r.from, r.to) || 'текст'
  const insert = `[${label}](url)`
  const urlFrom = r.from + label.length + 3 // после «[label](»
  view.dispatch({
    changes: { from: r.from, to: r.to, insert },
    selection: EditorSelection.range(urlFrom, urlFrom + 3)
  })
  view.focus()
  return true
}

/** Вставка блока на отдельных строках (таблица, линия). */
function insertBlock(view: EditorView, text: string): boolean {
  if (view.state.readOnly) return false
  const r = view.state.selection.main
  const line = view.state.doc.lineAt(r.from)
  const prefix = line.text === '' ? '' : '\n'
  const insert = prefix + text + '\n'
  view.dispatch({
    changes: { from: r.from, to: r.to, insert },
    selection: { anchor: r.from + insert.length }
  })
  view.focus()
  return true
}

export function insertTable(view: EditorView): boolean {
  if (view.state.readOnly) return false
  const r = view.state.selection.main
  const line = view.state.doc.lineAt(r.from)
  // GFM распознаёт таблицу только если перед ней пустая строка (иначе строки
  // сливаются в абзац). После — тоже перенос, чтобы отделить от текста ниже.
  const before = line.text === '' ? '' : '\n\n'
  const table = '| Колонка 1 | Колонка 2 |\n| --- | --- |\n|  |  |'
  const insert = before + table + '\n'
  view.dispatch({
    changes: { from: r.from, to: r.to, insert },
    selection: { anchor: r.from + insert.length }
  })
  view.focus()
  return true
}

export function insertHr(view: EditorView): boolean {
  return insertBlock(view, '---')
}

/** Блок кода: курсор ставится внутрь заборов, выделение уходит внутрь. */
export function insertCodeBlock(view: EditorView): boolean {
  if (view.state.readOnly) return false
  const r = view.state.selection.main
  const line = view.state.doc.lineAt(r.from)
  const prefix = line.text === '' ? '' : '\n'
  const body = view.state.sliceDoc(r.from, r.to)
  const head = prefix + '```\n'
  const insert = head + body + '\n```\n'
  view.dispatch({
    changes: { from: r.from, to: r.to, insert },
    selection: { anchor: r.from + head.length + body.length }
  })
  view.focus()
  return true
}

/** Снять инлайн-разметку с выделения. */
export function clearFormatting(view: EditorView): boolean {
  if (view.state.readOnly) return false
  const r = view.state.selection.main
  if (r.empty) return false
  const text = view.state.sliceDoc(r.from, r.to).replace(/\*\*|__|\*|_|~~|`/g, '')
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: text },
    selection: EditorSelection.range(r.from, r.from + text.length)
  })
  view.focus()
  return true
}

/** Cmd/Ctrl+B — жирный, Cmd/Ctrl+I — курсив. */
export const formattingKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: (v) => wrapSelection(v, '**'), preventDefault: true },
  { key: 'Mod-i', run: (v) => wrapSelection(v, '*'), preventDefault: true }
]
