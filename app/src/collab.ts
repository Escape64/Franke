// Сессия редактирования одной заметки/комнаты.
//
// С этапа 2 у заметки три режима:
//  • локальная (нет share-меты) — вообще без сети, только диск;
//  • общая (есть share-мета) — синхронизация через «слепой» relay шифроблобами;
//  • гость в браузере — та же шифрокомната по ссылке /d/<docId>#<key>, без диска.
// Старые plaintext-комнаты (?room=) остаются только как dev-демо.
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { WebsocketProvider } from 'y-websocket'
import { IndexeddbPersistence } from 'y-indexeddb'
import { EncryptedRelayProvider, type ProviderKeys } from './encrypted-provider'
import {
  generateKeyB64,
  generateSignPair,
  importKeyB64,
  importSignKey,
  importVerifyKey,
  randomDocId
} from './crypto'
import { createVersion } from './versions'
import {
  logFsError,
  readNote,
  readShareMeta,
  readSidecar,
  writeNote,
  writeShareMeta,
  writeSidecar,
  type ShareMeta
} from './vault'
import { relayUrl, guestUrlBase } from './config'

const SAVE_DEBOUNCE_MS = 500
const INITIAL_SYNC_WAIT_MS = 1500

/** Комната старого dev-демо (plaintext). */
export function roomForNote(rel: string): string {
  return `note:${encodeURIComponent(rel)}`
}

/**
 * Ссылки-приглашения. Формат фрагмента (частей через точку):
 *  редактирование: #<readKey>.<signPub>.<signPriv>
 *  только чтение:  #<readKey>.<signPub>
 *  легаси (этап 2): #<readKey> — деградирует до чтения без проверки подписей.
 */
export function inviteLink(meta: ShareMeta, mode: 'write' | 'read'): string {
  // Адрес relay кладём в query (не секрет), ключи — во фрагмент #.
  const relay = encodeURIComponent(relayUrl())
  const keys = mode === 'write'
    ? `${meta.key}.${meta.signPub}.${meta.signPriv}`
    : `${meta.key}.${meta.signPub}`
  return `${guestUrlBase()}/d/${meta.docId}?relay=${relay}#${keys}`
}

// Заголовок заметки хранится в самом Y.Doc (Y.Map 'meta'), поэтому
// синхронизируется всем — включая браузерного гостя, который имени файла на
// диске владельца не видит. Пишет заголовок только владелец (из имени файла),
// остальные читают.
export function sharedTitle(ydoc: Y.Doc): string | null {
  const t = ydoc.getMap('meta').get('title')
  return typeof t === 'string' && t ? t : null
}

export function setSharedTitle(ydoc: Y.Doc, title: string): void {
  const map = ydoc.getMap('meta')
  if (map.get('title') !== title) map.set('title', title)
}

/** Собрать ключи провайдера из меты владельца (полный доступ). */
async function ownerKeys(meta: ShareMeta): Promise<ProviderKeys> {
  return {
    readKey: await importKeyB64(meta.key),
    verifyKey: meta.signPub ? await importVerifyKey(meta.signPub) : null,
    signKey: meta.signPriv ? await importSignKey(meta.signPriv) : null
  }
}

export interface UserInfo {
  name: string
  color: string
  colorLight: string
}

type Provider = EncryptedRelayProvider | WebsocketProvider

export interface NoteSession {
  ydoc: Y.Doc
  ytext: Y.Text
  awareness: awarenessProtocol.Awareness
  /** null — локальная заметка без сети. */
  provider: Provider | null
  share: ShareMeta | null
  undoManager: Y.UndoManager
  /** true — гость в браузере (нет вольта, документ кэшируется в IndexedDB). */
  isGuest: boolean
  /** false — режим «только чтение» (read-ссылка или легаси-ссылка). */
  canWrite: boolean
  /** Внешняя правка .md с диска → влить diff в CRDT. */
  reconcileFromDisk: (diskText: string) => void
  destroy: () => Promise<void>
}

/**
 * Общий diff «текст → ytext» через общие префикс/суффикс: правки сливаются
 * как обычная вставка/удаление, чужие курсоры не сбрасываются.
 */
function applyTextDiff(ytext: Y.Text, next: string, origin: unknown): void {
  const prev = ytext.toString()
  if (prev === next) return
  let start = 0
  const minLen = Math.min(prev.length, next.length)
  while (start < minLen && prev[start] === next[start]) start++
  let prevEnd = prev.length
  let nextEnd = next.length
  while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
    prevEnd--
    nextEnd--
  }
  ytext.doc!.transact(() => {
    if (prevEnd > start) ytext.delete(start, prevEnd - start)
    if (nextEnd > start) ytext.insert(start, next.slice(start, nextEnd))
  }, origin)
}

/** Минимальная поверхность провайдера, нужная для ожидания синхронизации. */
interface SyncedEmitter {
  synced: boolean
  on(event: 'synced', handler: () => void): void
  off(event: 'synced', handler: () => void): void
}

/** Дождаться первого sync с relay (или таймаута, если relay недоступен). */
function waitForSync(p: Provider, timeoutMs: number): Promise<void> {
  const provider = p as unknown as SyncedEmitter
  if (provider.synced) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs)
    function done() {
      clearTimeout(timer)
      provider.off('synced', done)
      resolve()
    }
    provider.on('synced', done)
  })
}

/** Dev-демо в браузере: plaintext-комната, только сеть, без диска. */
export function openRoom(room: string, user: UserInfo): NoteSession {
  const ydoc = new Y.Doc({ gc: false })
  const ytext = ydoc.getText('content')
  const provider = new WebsocketProvider(relayUrl(), room, ydoc)
  provider.awareness.setLocalStateField('user', user)
  return {
    ydoc,
    ytext,
    awareness: provider.awareness,
    provider,
    share: null,
    undoManager: new Y.UndoManager(ytext),
    isGuest: false,
    canWrite: true,
    reconcileFromDisk: () => {},
    destroy: async () => {
      provider.destroy()
      ydoc.destroy()
    }
  }
}

/**
 * Гость в браузере: шифрокомната по данным из ссылки.
 *
 * Документ кэшируется в IndexedDB (ключ базы — docId), поэтому переживает
 * перезагрузку вкладки и офлайн-владельца. Сначала поднимаем локальный кэш и
 * ждём его загрузки, только потом подключаем сетевой провайдер — иначе первое
 * состояние с relay могло бы разойтись с ещё не подгруженным локальным.
 */
export async function openEncryptedRoom(
  docId: string,
  fragment: string,
  user: UserInfo
): Promise<NoteSession> {
  const ydoc = new Y.Doc({ gc: false })
  const ytext = ydoc.getText('content')

  const idb = new IndexeddbPersistence(`franke-guest:${docId}`, ydoc)
  await idb.whenSynced // локальный кэш загружен (или пуст при первом визите)

  // Фрагмент ссылки: readKey.signPub[.signPriv] — см. inviteLink.
  // Ссылки этапа 2 (только readKey) несовместимы с подписанным форматом
  // кадров — честно просим новую вместо молча пустого документа.
  const [keyB64, signPub, signPriv] = fragment.split('.')
  if (!signPub) throw new Error('legacy-link')
  const keys: ProviderKeys = {
    readKey: await importKeyB64(keyB64),
    verifyKey: await importVerifyKey(signPub),
    signKey: signPriv ? await importSignKey(signPriv) : null
  }
  const provider = new EncryptedRelayProvider(relayUrl(), docId, keys, ydoc)
  provider.awareness.setLocalStateField('user', user)

  return {
    ydoc,
    ytext,
    awareness: provider.awareness,
    provider,
    share: { docId, key: keyB64, signPub, signPriv },
    undoManager: new Y.UndoManager(ytext),
    isGuest: true,
    canWrite: provider.canWrite,
    reconcileFromDisk: () => {},
    destroy: async () => {
      await provider.destroy()
      await idb.destroy()
      ydoc.destroy()
    }
  }
}

/** Включить общий доступ: сгенерировать docId и все ключи, сохранить у владельца. */
export async function shareNote(rel: string): Promise<ShareMeta> {
  const pair = await generateSignPair()
  const meta: ShareMeta = {
    docId: randomDocId(),
    key: await generateKeyB64(),
    signPub: pair.pub,
    signPriv: pair.priv
  }
  await writeShareMeta(rel, meta)
  return meta
}

/**
 * Отзыв доступа = ротация: новые docId и ВСЕ ключи. Старые ссылки перестают
 * получать новые правки (старая комната замирает на relay). Новую ссылку
 * нужно разослать заново. Вызывающий должен переоткрыть сессию заметки —
 * свежий провайдер зальёт полное состояние в новую комнату после sync.
 */
export async function rotateShare(rel: string): Promise<ShareMeta> {
  return shareNote(rel) // тот же генератор: полный новый комплект
}

/**
 * Tauri-режим: заметка вольта с персистентностью; сеть — только если заметкой
 * поделились (есть share-мета).
 *
 * Порядок загрузки: CRDT-история из sidecar → diff с текстом .md (правки,
 * сделанные пока приложение было закрыто). Если sidecar'а нет, а комната уже
 * живёт на relay — сначала sync и засев только пустого документа (слепой засев
 * продублировал бы содержимое).
 */
export async function openNote(rel: string, user: UserInfo): Promise<NoteSession> {
  const ydoc = new Y.Doc({ gc: false })
  const ytext = ydoc.getText('content')

  const stored = await readSidecar(rel)
  const diskText = await readNote(rel)
  let share = await readShareMeta(rel)

  // Апгрейд меты этапа 2 (без ключей подписи): дополняем парой ECDSA.
  // Старые ссылки «#key» при этом деградируют до чтения — попросить новую.
  if (share && (!share.signPub || !share.signPriv)) {
    const pair = await generateSignPair()
    share = { ...share, signPub: pair.pub, signPriv: pair.priv }
    await writeShareMeta(rel, share)
  }

  let provider: EncryptedRelayProvider | null = null
  let awareness: awarenessProtocol.Awareness
  if (share) {
    provider = new EncryptedRelayProvider(relayUrl(), share.docId, await ownerKeys(share), ydoc)
    awareness = provider.awareness
  } else {
    awareness = new awarenessProtocol.Awareness(ydoc)
  }
  awareness.setLocalStateField('user', user)

  if (stored) {
    // Есть sidecar — у документа общая история, diff с диском безопасен.
    Y.applyUpdate(ydoc, stored, 'disk')
    if (diskText !== null) applyTextDiff(ytext, diskText, 'disk')
  } else if (diskText !== null && diskText !== '') {
    if (provider) await waitForSync(provider, INITIAL_SYNC_WAIT_MS)
    if (ytext.toString() === '') {
      applyTextDiff(ytext, diskText, 'disk')
    }
    // Если документ непуст — правда на relay, файл перезапишется сохранением.
  }

  // Владелец кладёт заголовок (имя файла) в общий документ, чтобы гость видел
  // настоящее название заметки, а не заглушку.
  setSharedTitle(ydoc, rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, ''))

  // Чекпойнт истории при открытии: если состояние изменилось с последней
  // версии, фиксируем его (дедупликация внутри createVersion).
  if (ytext.toString() !== '') createVersion(ydoc, user.name)

  // Текст, который лежит в .md на данный момент: сверяясь с ним, отличаем
  // собственные записи от внешних правок и не пишем файл без изменений.
  let lastDiskText = diskText ?? ''
  const undoManager = new Y.UndoManager(ytext)

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let savingChain: Promise<void> = Promise.resolve()

  const saveNow = () => {
    // Последовательная цепочка, чтобы записи не обгоняли друг друга.
    // Ошибка одной записи логируется и не «закупоривает» цепочку навсегда.
    savingChain = savingChain
      .then(async () => {
        const text = ytext.toString()
        await writeSidecar(rel, Y.encodeStateAsUpdate(ydoc))
        if (text !== lastDiskText) {
          lastDiskText = text
          await writeNote(rel, text)
        }
      })
      .catch((e) => void logFsError(`save(${rel})`, e))
    return savingChain
  }

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS)
  }

  ydoc.on('update', scheduleSave)
  // Стартовое состояние (sync с relay или посев с диска) приходит ДО этой
  // подписки — фиксируем его на диск сразу, не дожидаясь первой правки.
  void saveNow()

  return {
    ydoc,
    ytext,
    awareness,
    provider,
    share,
    undoManager,
    isGuest: false,
    canWrite: true,
    reconcileFromDisk: (text: string) => {
      if (text === lastDiskText) return // это наша собственная запись
      lastDiskText = text
      applyTextDiff(ytext, text, 'disk')
    },
    destroy: async () => {
      if (saveTimer) clearTimeout(saveTimer)
      await saveNow()
      if (provider) await provider.destroy()
      else awareness.destroy()
      ydoc.destroy()
    }
  }
}
