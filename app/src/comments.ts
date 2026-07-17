// Комментарии к выделению живут в том же Y.Doc, что и текст, — поэтому
// синхронизируются и мёржатся ровно так же, как правки, и работают офлайн.
//
// Структура:
//   ydoc.getMap('comments'): threadId -> Y.Map (тред)
//   тред: {
//     start, end: Uint8Array — Y.RelativePosition (переживают правки текста),
//     quote: string          — цитата выделения на момент создания (для панели),
//     resolved: boolean,
//     createdAt: number,
//     messages: Y.Array<Y.Map> — [{ author, color, text, ts }]
//   }
import * as Y from 'yjs'

export interface ThreadMessage {
  author: string
  color: string
  text: string
  ts: number
}

export interface ThreadView {
  id: string
  from: number
  to: number
  quote: string
  resolved: boolean
  createdAt: number
  messages: ThreadMessage[]
}

const COMMENTS_KEY = 'comments'

export function commentsMap(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return ydoc.getMap(COMMENTS_KEY)
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Создать тред на диапазоне [from, to) текущего текста.
 * Возвращает id треда (или null, если выделение пустое).
 */
export function createThread(
  ydoc: Y.Doc,
  ytext: Y.Text,
  from: number,
  to: number,
  first: ThreadMessage
): string | null {
  if (to <= from) return null
  const id = randomId()
  const start = Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(ytext, from)
  )
  // assoc=-1 у конца: правка ровно на границе не «утягивает» конец диапазона.
  const end = Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(ytext, to, -1)
  )
  const thread = new Y.Map<unknown>()
  const messages = new Y.Array<Y.Map<unknown>>()

  ydoc.transact(() => {
    thread.set('start', start)
    thread.set('end', end)
    thread.set('quote', ytext.toString().slice(from, to))
    thread.set('resolved', false)
    thread.set('createdAt', Date.now())
    thread.set('messages', messages)
    appendToArray(messages, first)
    commentsMap(ydoc).set(id, thread)
  })
  return id
}

export function replyToThread(ydoc: Y.Doc, threadId: string, msg: ThreadMessage): void {
  const thread = commentsMap(ydoc).get(threadId)
  if (!thread) return
  const messages = thread.get('messages') as Y.Array<Y.Map<unknown>> | undefined
  if (messages) ydoc.transact(() => appendToArray(messages, msg))
}

export function setThreadResolved(ydoc: Y.Doc, threadId: string, resolved: boolean): void {
  const thread = commentsMap(ydoc).get(threadId)
  if (thread) ydoc.transact(() => thread.set('resolved', resolved))
}

export function deleteThread(ydoc: Y.Doc, threadId: string): void {
  ydoc.transact(() => commentsMap(ydoc).delete(threadId))
}

function appendToArray(messages: Y.Array<Y.Map<unknown>>, msg: ThreadMessage): void {
  const m = new Y.Map<unknown>()
  m.set('author', msg.author)
  m.set('color', msg.color)
  m.set('text', msg.text)
  m.set('ts', msg.ts)
  messages.push([m])
}

/**
 * Снимок всех тредов с абсолютными позициями [from, to) в текущем тексте.
 * Треды, чей якорь больше не разрешается (текст удалён целиком), отбрасываются.
 * Отсортированы по позиции начала — для панели и подсветки.
 */
export function threadViews(ydoc: Y.Doc, ytext: Y.Text): ThreadView[] {
  const out: ThreadView[] = []
  for (const [id, thread] of commentsMap(ydoc)) {
    const startEnc = thread.get('start') as Uint8Array | undefined
    const endEnc = thread.get('end') as Uint8Array | undefined
    if (!startEnc || !endEnc) continue
    const from = relPosToIndex(ydoc, startEnc)
    const to = relPosToIndex(ydoc, endEnc)
    if (from === null || to === null || to <= from) continue

    const messages = (thread.get('messages') as Y.Array<Y.Map<unknown>> | undefined) ?? null
    out.push({
      id,
      from,
      to,
      quote: (thread.get('quote') as string) ?? '',
      resolved: Boolean(thread.get('resolved')),
      createdAt: (thread.get('createdAt') as number) ?? 0,
      messages: messages ? messages.map(readMessage) : []
    })
  }
  return out.sort((a, b) => a.from - b.from || a.createdAt - b.createdAt)
}

function readMessage(m: Y.Map<unknown>): ThreadMessage {
  return {
    author: (m.get('author') as string) ?? '?',
    color: (m.get('color') as string) ?? '#888',
    text: (m.get('text') as string) ?? '',
    ts: (m.get('ts') as number) ?? 0
  }
}

function relPosToIndex(ydoc: Y.Doc, enc: Uint8Array): number | null {
  const abs = Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(enc),
    ydoc
  )
  return abs ? abs.index : null
}
