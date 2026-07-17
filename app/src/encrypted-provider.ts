// Провайдер синхронизации через «слепой» relay: сервер видит только
// зашифрованные блобы (JSON-кадры {type, blob}), Yjs-протокола на сервере нет.
//
// Протокол комнаты /e/<docId>:
//  при подключении сервер отдаёт весь журнал update-кадров, затем {type:"synced"};
//  наши update-кадры сервер дописывает в журнал и транслирует остальным;
//  awareness-кадры только транслируются (не хранятся).
//
// Права (этап 5): чтение = владение AES-ключом; запись = подпись ECDSA.
// Внутри шифроконверта update-кадра лежит sig(64Б) + update; входящие правки
// без валидной подписи отбрасываются. Awareness не подписывается — присутствие
// и курсор доступны и читателям. Легаси-режим (verifyKey === null) не
// проверяет подписи — используется только для старых ссылок в режиме чтения.
//
// Компромисс прототипа: после каждого synced клиент-писатель шлёт полное
// состояние документа одним блобом — гарантирует сходимость после офлайна
// ценой роста журнала. Дельта-протокол — в этапе «рост».
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import {
  decryptBlob,
  encryptBlob,
  fromBase64Url,
  SIGNATURE_BYTES,
  signData,
  toBase64Url,
  verifyData
} from './crypto'

const RECONNECT_MS = 1500

type EventName = 'status' | 'synced'
type Handler = (arg: unknown) => void

export interface ProviderKeys {
  /** AES-ключ чтения (расшифровка всех кадров). */
  readKey: CryptoKey
  /** Ключ проверки подписей; null — легаси-ссылка без проверки. */
  verifyKey: CryptoKey | null
  /** Ключ подписи; null — режим «только чтение». */
  signKey: CryptoKey | null
}

export class EncryptedRelayProvider {
  readonly awareness: awarenessProtocol.Awareness
  readonly canWrite: boolean
  wsconnected = false
  synced = false

  private ws: WebSocket | null = null
  private destroyed = false
  /** Правки, сделанные без связи: доотправляются после synced. */
  private pending: string[] = []
  private listeners = new Map<EventName, Set<Handler>>()

  constructor(
    private serverUrl: string,
    private docId: string,
    private keys: ProviderKeys,
    private ydoc: Y.Doc
  ) {
    this.canWrite = keys.signKey !== null
    this.awareness = new awarenessProtocol.Awareness(ydoc)
    ydoc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
    this.connect()
  }

  on(event: EventName, handler: Handler): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(handler)
  }

  off(event: EventName, handler: Handler): void {
    this.listeners.get(event)?.delete(handler)
  }

  private emit(event: EventName, arg: unknown): void {
    for (const h of this.listeners.get(event) ?? []) h(arg)
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return
    if (!this.keys.signKey) {
      // Read-only: локальные правки не должны возникать (редактор заблокирован),
      // но на всякий случай не транслируем их.
      console.warn('franke: правка в режиме «только чтение» не отправлена')
      return
    }
    void this.sendUpdate(update)
  }

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    if (origin === this) return
    const changed = added.concat(updated, removed)
    void this.sendFrame(
      'awareness',
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)
    )
  }

  /** Подписать и отправить update: конверт = enc(sig || update). */
  private async sendUpdate(update: Uint8Array): Promise<void> {
    const sig = await signData(this.keys.signKey!, update)
    const payload = new Uint8Array(SIGNATURE_BYTES + update.length)
    payload.set(sig, 0)
    payload.set(update, SIGNATURE_BYTES)
    await this.sendFrame('update', payload)
  }

  private async sendFrame(type: 'update' | 'awareness', data: Uint8Array): Promise<void> {
    const msg = JSON.stringify({
      type,
      blob: toBase64Url(await encryptBlob(this.keys.readKey, data))
    })
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msg)
    } else if (type === 'update') {
      this.pending.push(msg) // awareness устаревает мгновенно — не копим
    }
  }

  private connect(): void {
    if (this.destroyed) return
    const ws = new WebSocket(`${this.serverUrl}/e/${this.docId}`)
    this.ws = ws
    ws.onopen = () => {
      this.wsconnected = true
      this.emit('status', { status: 'connected' })
    }
    ws.onclose = () => {
      this.wsconnected = false
      this.synced = false
      this.emit('status', { status: 'disconnected' })
      if (!this.destroyed) setTimeout(() => this.connect(), RECONNECT_MS)
    }
    ws.onmessage = (ev) => void this.onMessage(String(ev.data))
  }

  private async onMessage(raw: string): Promise<void> {
    let msg: { type: string; blob?: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    switch (msg.type) {
      case 'update':
        try {
          const payload = await decryptBlob(this.keys.readKey, fromBase64Url(msg.blob!))
          let update: Uint8Array
          if (this.keys.verifyKey) {
            const sig = payload.slice(0, SIGNATURE_BYTES)
            update = payload.slice(SIGNATURE_BYTES)
            if (!(await verifyData(this.keys.verifyKey, sig, update))) {
              console.warn('franke: правка с невалидной подписью отброшена')
              return
            }
          } else {
            // Легаси без проверки: конверт содержит только update.
            update = payload
          }
          Y.applyUpdate(this.ydoc, update, this)
        } catch (e) {
          console.error('franke: не удалось расшифровать обновление (неверный ключ?)', e)
        }
        break
      case 'awareness':
        try {
          const data = await decryptBlob(this.keys.readKey, fromBase64Url(msg.blob!))
          awarenessProtocol.applyAwarenessUpdate(this.awareness, data, this)
        } catch {
          // повреждённый/чужой awareness-кадр — просто пропускаем
        }
        break
      case 'synced': {
        this.synced = true
        for (const m of this.pending.splice(0)) this.ws?.send(m)
        if (this.keys.signKey && this.ydoc.store.clients.size > 0) {
          void this.sendUpdate(Y.encodeStateAsUpdate(this.ydoc))
        }
        // Публикуем своё awareness-состояние для только что увиденных пиров.
        const local = this.awareness.getLocalState()
        if (local !== null) this.awareness.setLocalState(local)
        this.emit('synced', true)
        break
      }
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    this.ydoc.off('update', this.onDocUpdate)
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.ydoc.clientID],
      'destroy'
    )
    this.awareness.destroy()
    this.ws?.close()
  }
}
