// Franke relay — этап 1: собственная реализация вместо @y/websocket-server,
// на тех же yjs 13 + y-protocols, что и клиенты (готовый пакет собран под
// протокол yjs 14 и молча не декодирует sync-сообщения наших клиентов).
//
// Комната = путь URL. Документы живут в памяти, пока есть подключения;
// персистентность и шифрование — этап 2.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const MSG_SYNC = 0
const MSG_AWARENESS = 1

const port = Number(process.env.PORT ?? 1234)

/** @type {Map<string, Room>} */
const rooms = new Map()

class Room {
  constructor(name) {
    this.name = name
    this.ydoc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.ydoc)
    this.awareness.setLocalState(null)
    /** @type {Map<import('ws').WebSocket, Set<number>>} соединение → его awareness clientID */
    this.conns = new Map()

    this.ydoc.on('update', (update, origin) => {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      syncProtocol.writeUpdate(enc, update)
      this.broadcast(encoding.toUint8Array(enc), origin)
    })

    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed)
      if (origin instanceof Object && this.conns.has(origin)) {
        const ids = this.conns.get(origin)
        added.forEach((id) => ids.add(id))
        removed.forEach((id) => ids.delete(id))
      }
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_AWARENESS)
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)
      )
      this.broadcast(encoding.toUint8Array(enc), null)
    })
  }

  broadcast(msg, exclude) {
    for (const conn of this.conns.keys()) {
      if (conn !== exclude && conn.readyState === conn.OPEN) conn.send(msg)
    }
  }

  addConn(conn) {
    this.conns.set(conn, new Set())
    // Рукопожатие: наш SyncStep1 + текущие awareness-состояния
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeSyncStep1(enc, this.ydoc)
    conn.send(encoding.toUint8Array(enc))

    const states = this.awareness.getStates()
    if (states.size > 0) {
      const encA = encoding.createEncoder()
      encoding.writeVarUint(encA, MSG_AWARENESS)
      encoding.writeVarUint8Array(
        encA,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()])
      )
      conn.send(encoding.toUint8Array(encA))
    }
  }

  onMessage(conn, data) {
    const decoder = decoding.createDecoder(new Uint8Array(data))
    const msgType = decoding.readVarUint(decoder)
    switch (msgType) {
      case MSG_SYNC: {
        const enc = encoding.createEncoder()
        encoding.writeVarUint(enc, MSG_SYNC)
        syncProtocol.readSyncMessage(decoder, enc, this.ydoc, conn)
        // Ответ (SyncStep2 и/или встречный SyncStep1) — только если он не пуст
        if (encoding.length(enc) > 1 && conn.readyState === conn.OPEN) {
          conn.send(encoding.toUint8Array(enc))
        }
        break
      }
      case MSG_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          conn
        )
        break
      default:
      // неизвестный тип сообщения — игнорируем
    }
  }

  removeConn(conn) {
    const ids = this.conns.get(conn)
    this.conns.delete(conn)
    if (ids) awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null)
    if (this.conns.size === 0) {
      this.awareness.destroy()
      this.ydoc.destroy()
      rooms.delete(this.name)
    }
  }
}

// --- Слепые комнаты (этап 2): путь /e/<docId> ---
// Сервер не понимает содержимое: хранит журнал зашифрованных update-кадров
// (store-and-forward для офлайн-участников) и транслирует их подключённым.
// Awareness-кадры не хранятся. Журнал должен пережить и офлайн владельца, и
// рестарт relay: пишем его на диск (JSONL-файл на docId в DATA_DIR).
// DATA_DIR="" отключает диск (журнал только в памяти, как раньше).
const dataDir = process.env.DATA_DIR ?? './data'
if (dataDir) fs.mkdirSync(dataDir, { recursive: true })

// Лимиты против злоупотреблений публичным relay. Компакция журнала осознанно
// отложена: relay слеп и не отличает кадр полного состояния от дельты.
const MAX_FRAME_BYTES = 2 * 1024 * 1024 // один update-кадр
const MAX_LOG_BYTES = 50 * 1024 * 1024 // журнал одной комнаты

// docId приходит из URL — в имя файла только после строгой проверки формата.
const validDocId = (id) => /^[A-Za-z0-9_-]{1,128}$/.test(id)
const roomFile = (docId) => path.join(dataDir, `${docId}.jsonl`)

/** @type {Map<string, {log: string[], bytes: number, conns: Set<import('ws').WebSocket>}>} */
const blobRooms = new Map()

function getBlobRoom(docId) {
  let room = blobRooms.get(docId)
  if (room) return room
  room = { log: [], bytes: 0, conns: new Set() }
  if (dataDir) {
    try {
      const raw = fs.readFileSync(roomFile(docId), 'utf8')
      for (const line of raw.split('\n')) {
        if (!line) continue
        room.log.push(line)
        room.bytes += Buffer.byteLength(line) + 1
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`шифрокомната ${docId}: не прочитан журнал:`, e)
    }
  }
  blobRooms.set(docId, room)
  return room
}

function handleBlobConn(conn, docId) {
  if (!validDocId(docId)) {
    conn.close()
    return
  }
  const room = getBlobRoom(docId)
  room.conns.add(conn)

  for (const frame of room.log) conn.send(frame)
  conn.send('{"type":"synced"}')

  conn.on('message', (data) => {
    let msg
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    if (typeof msg.blob !== 'string') return
    if (msg.type === 'update') {
      if (msg.blob.length > MAX_FRAME_BYTES) {
        console.warn(`шифрокомната ${docId}: кадр больше лимита, отброшен`)
        return
      }
      const frame = JSON.stringify({ type: 'update', seq: room.log.length + 1, blob: msg.blob })
      const size = Buffer.byteLength(frame) + 1
      if (room.bytes + size > MAX_LOG_BYTES) {
        console.warn(`шифрокомната ${docId}: журнал переполнен, кадр отброшен`)
        return
      }
      room.log.push(frame)
      room.bytes += size
      if (dataDir) {
        // Синхронный append сохраняет порядок кадров; трафик небольшой.
        try {
          fs.appendFileSync(roomFile(docId), frame + '\n')
        } catch (e) {
          console.error(`шифрокомната ${docId}: не записан журнал:`, e)
        }
      }
      for (const c of room.conns) {
        if (c !== conn && c.readyState === c.OPEN) c.send(frame)
      }
    } else if (msg.type === 'awareness') {
      const frame = JSON.stringify({ type: 'awareness', blob: msg.blob })
      for (const c of room.conns) {
        if (c !== conn && c.readyState === c.OPEN) c.send(frame)
      }
    }
  })
  const drop = () => {
    room.conns.delete(conn)
    // С диском пустую комнату можно выгрузить из памяти — вернётся с файла.
    // Без диска держим в памяти: журнал должен пережить офлайн владельца.
    if (dataDir && room.conns.size === 0) blobRooms.delete(docId)
  }
  conn.on('close', drop)
  conn.on('error', drop)
}

const server = http.createServer((req, res) => {
  // Отдельная ручка для Docker healthcheck: без счётчиков, стабильный ответ.
  if ((req.url ?? '/').startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok\n')
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(`franke relay ok · комнат: ${rooms.size} · шифрокомнат: ${blobRooms.size}\n`)
})

const wss = new WebSocketServer({ server })

wss.on('connection', (conn, req) => {
  const name = (req.url ?? '/').slice(1).split('?')[0]

  if (name.startsWith('e/')) {
    handleBlobConn(conn, name.slice(2))
    return
  }

  let room = rooms.get(name)
  if (!room) {
    room = new Room(name)
    rooms.set(name, room)
  }
  room.addConn(conn)

  conn.on('message', (data) => {
    try {
      room.onMessage(conn, data)
    } catch (e) {
      console.error(`ошибка обработки сообщения в комнате ${name}:`, e)
    }
  })
  conn.on('close', () => room.removeConn(conn))
  conn.on('error', () => room.removeConn(conn))
})

server.listen(port, () => {
  console.log(`franke relay: ws://localhost:${port}`)
})
