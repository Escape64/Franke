// Режим предложений: правки-предложения к выделению живут в том же Y.Doc
// (как комментарии), синхронизируются и мёржатся так же.
//
// Единая модель replace: диапазон [start, end) заменяется на newText.
//   • end == start          → чистая вставка;
//   • newText == ''          → удаление;
//   • иначе                  → замена.
// oldText — снимок исходного фрагмента (для показа в панели и как страховка).
import * as Y from 'yjs'

export interface SuggestionView {
  id: string
  from: number
  to: number
  oldText: string
  newText: string
  author: string
  color: string
  ts: number
}

const SUGGESTIONS_KEY = 'suggestions'

export function suggestionsMap(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return ydoc.getMap(SUGGESTIONS_KEY)
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export interface NewSuggestion {
  author: string
  color: string
  newText: string
}

/** Создать предложение на диапазоне [from, to) текущего текста. */
export function createSuggestion(
  ydoc: Y.Doc,
  ytext: Y.Text,
  from: number,
  to: number,
  s: NewSuggestion
): string | null {
  const oldText = ytext.toString().slice(from, to)
  if (oldText === '' && s.newText === '') return null // нечего предлагать
  const id = randomId()
  const start = Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(ytext, from)
  )
  const end = Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(ytext, to, -1)
  )
  const sug = new Y.Map<unknown>()
  ydoc.transact(() => {
    sug.set('start', start)
    sug.set('end', end)
    sug.set('oldText', oldText)
    sug.set('newText', s.newText)
    sug.set('author', s.author)
    sug.set('color', s.color)
    sug.set('ts', Date.now())
    suggestionsMap(ydoc).set(id, sug)
  })
  return id
}

/** Принять: применить замену к тексту и удалить предложение. */
export function acceptSuggestion(ydoc: Y.Doc, ytext: Y.Text, id: string): void {
  const sug = suggestionsMap(ydoc).get(id)
  if (!sug) return
  const from = relPosToIndex(ydoc, sug.get('start') as Uint8Array)
  const to = relPosToIndex(ydoc, sug.get('end') as Uint8Array)
  if (from === null || to === null || to < from) {
    // Якорь разрушен (текст удалён) — просто снимаем предложение.
    suggestionsMap(ydoc).delete(id)
    return
  }
  const newText = (sug.get('newText') as string) ?? ''
  ydoc.transact(() => {
    if (to > from) ytext.delete(from, to - from)
    if (newText) ytext.insert(from, newText)
    suggestionsMap(ydoc).delete(id)
  })
}

/** Отклонить: удалить предложение, текст не трогаем. */
export function rejectSuggestion(ydoc: Y.Doc, id: string): void {
  ydoc.transact(() => suggestionsMap(ydoc).delete(id))
}

/** Снимок предложений с абсолютными позициями в текущем тексте. */
export function suggestionViews(ydoc: Y.Doc, ytext: Y.Text): SuggestionView[] {
  void ytext
  const out: SuggestionView[] = []
  for (const [id, sug] of suggestionsMap(ydoc)) {
    const startEnc = sug.get('start') as Uint8Array | undefined
    const endEnc = sug.get('end') as Uint8Array | undefined
    if (!startEnc || !endEnc) continue
    const from = relPosToIndex(ydoc, startEnc)
    const to = relPosToIndex(ydoc, endEnc)
    if (from === null || to === null || to < from) continue
    out.push({
      id,
      from,
      to,
      oldText: (sug.get('oldText') as string) ?? '',
      newText: (sug.get('newText') as string) ?? '',
      author: (sug.get('author') as string) ?? '?',
      color: (sug.get('color') as string) ?? '#888',
      ts: (sug.get('ts') as number) ?? 0
    })
  }
  return out.sort((a, b) => a.from - b.from || a.ts - b.ts)
}

function relPosToIndex(ydoc: Y.Doc, enc: Uint8Array): number | null {
  const abs = Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(enc),
    ydoc
  )
  return abs ? abs.index : null
}
