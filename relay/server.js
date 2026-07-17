// Franke relay — этап 1: собственная реализация вместо @y/websocket-server,
// на тех же yjs 13 + y-protocols, что и клиенты (готовый пакет собран под
// протокол yjs 14 и молча не декодирует sync-сообщения наших клиентов).
//
// Комната = путь URL. Документы живут в памяти, пока есть подключения;
// персистентность и шифрование — этап 2.
import http from 'node:http'
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
// Awareness-кадры не хранятся. Комнаты не удаляются при отключении всех
// участников — журнал должен пережить офлайн владельца (персистентность
// журнала на диск — этап «рост»).
/** @type {Map<string, {log: string[], conns: Set<import('ws').WebSocket>}>} */
const blobRooms = new Map()

function handleBlobConn(conn, docId) {
  let room = blobRooms.get(docId)
  if (!room) {
    room = { log: [], conns: new Set() }
    blobRooms.set(docId, room)
  }
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
      const frame = JSON.stringify({ type: 'update', seq: room.log.length + 1, blob: msg.blob })
      room.log.push(frame)
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
  const drop = () => room.conns.delete(conn)
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
