// История версий на снапшотах Yjs. Снапшот — компактный слепок состояния
// (вектор состояния + delete set), а не копия текста: старый текст
// восстанавливается из истории самого документа. Для этого документ должен
// хранить удалённый контент — все Y.Doc создаются с gc: false (см. collab.ts).
//
// Версии лежат в том же Y.Doc (Y.Array 'versions'), поэтому синхронизируются
// всем участникам, включая браузерных гостей.
//
// Восстановление — это forward-правка (diff текущего текста к старому),
// история не переписывается и ничего не теряется.
import * as Y from 'yjs'

export interface VersionView {
  index: number
  ts: number
  author: string
  snapshot: Uint8Array
}

const VERSIONS_KEY = 'versions'

export function versionsArray(ydoc: Y.Doc): Y.Array<Y.Map<unknown>> {
  return ydoc.getArray(VERSIONS_KEY)
}

/**
 * Сохранить версию (чекпойнт) текущего состояния.
 * Дедупликация: если состояние не изменилось с последней версии — не пишем.
 * Возвращает true, если версия записана.
 */
export function createVersion(ydoc: Y.Doc, author: string): boolean {
  const snap = Y.snapshot(ydoc)
  const arr = versionsArray(ydoc)
  const last = arr.length > 0 ? arr.get(arr.length - 1) : null
  if (last) {
    const lastSnap = Y.decodeSnapshot(last.get('snapshot') as Uint8Array)
    if (Y.equalSnapshots(lastSnap, snap)) return false
  }
  const entry = new Y.Map<unknown>()
  ydoc.transact(() => {
    entry.set('snapshot', Y.encodeSnapshot(snap))
    entry.set('ts', Date.now())
    entry.set('author', author)
    arr.push([entry])
  })
  return true
}

/** Все версии по порядку создания. */
export function listVersions(ydoc: Y.Doc): VersionView[] {
  const out: VersionView[] = []
  versionsArray(ydoc).forEach((entry, index) => {
    const snapshot = entry.get('snapshot') as Uint8Array | undefined
    if (!snapshot) return
    out.push({
      index,
      ts: (entry.get('ts') as number) ?? 0,
      author: (entry.get('author') as string) ?? '?',
      snapshot
    })
  })
  return out
}

/**
 * Текст документа на момент версии. Требует gc:false с момента создания
 * контента; если история недоступна (старые GC-документы) — вернёт null.
 */
export function textAtVersion(ydoc: Y.Doc, snapshotEnc: Uint8Array): string | null {
  try {
    const snap = Y.decodeSnapshot(snapshotEnc)
    const docAt = Y.createDocFromSnapshot(ydoc, snap)
    const text = docAt.getText('content').toString()
    docAt.destroy()
    return text
  } catch (e) {
    console.error('franke: не удалось восстановить версию', e)
    return null
  }
}
