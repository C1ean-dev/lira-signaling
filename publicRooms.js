const MAX_MESSAGE_BYTES = 16 * 1024
const ROOM_TTL_MS = 20000

function metadata(input, now) {
  if (!input || typeof input !== 'object') return null
  const result = {}
  const limits = { id: 128, code: 128, name: 160, hostId: 256, hostName: 160, color: 64, description: 512, hostColor: 64, announcementId: 128 }
  for (const [key, limit] of Object.entries(limits)) {
    const value = input[key]
    if ((value === undefined || value === '') && ['description', 'hostColor', 'announcementId'].includes(key)) continue
    if (typeof value !== 'string' || !value.trim() || value.length > limit) return null
    result[key] = value
  }
  for (const key of ['playerCount', 'maxPlayers']) {
    if (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > 10000) return null
    result[key] = input[key]
  }
  if (result.maxPlayers < 1 || result.playerCount > result.maxPlayers) return null
  if (Number.isInteger(input.zonesCount) && input.zonesCount >= 0) result.zonesCount = input.zonesCount
  result.createdAt = Number.isFinite(input.createdAt) && input.createdAt <= now ? input.createdAt : now
  result.lastHeartbeat = now
  return result
}

export function createPublicRoomsHub(wss, { now = Date.now, pruneIntervalMs = 5000 } = {}) {
  const rooms = new Map()
  const clients = new Set()
  const send = (socket, message) => {
    if (socket.readyState !== 1) return
    try { socket.send(JSON.stringify(message)) } catch {}
  }
  const broadcast = message => clients.forEach(socket => send(socket, message))
  const remove = code => {
    rooms.delete(code)
    broadcast({ type: 'UNREGISTER_ROOM', roomId: code, timestamp: now() })
  }
  const prune = () => {
    for (const [code, entry] of rooms) if (now() - entry.room.lastHeartbeat > ROOM_TTL_MS) remove(code)
  }
  wss.on('connection', socket => {
    clients.add(socket)
    send(socket, { type: 'READY', protocolVersion: 1 })
    socket.on('error', () => {})
    socket.on('message', data => {
      try {
        if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES) return
        const message = JSON.parse(String(data))
        if (!message || typeof message !== 'object') return
        prune()
        if (message.type === 'QUERY_ROOMS') {
          for (const { room } of rooms.values()) send(socket, { type: 'ANNOUNCE_ROOM', roomInfo: room, timestamp: now() })
        } else if (message.type === 'ANNOUNCE_ROOM' || message.type === 'HEARTBEAT') {
          const room = metadata(message.roomInfo, now())
          if (!room) return
          const existing = rooms.get(room.code)
          if (existing && existing.owner !== socket) return
          // Each host connection advertises at most one room.
          for (const [code, entry] of rooms) if (entry.owner === socket && code !== room.code) remove(code)
          if (existing) room.createdAt = existing.room.createdAt
          rooms.set(room.code, { owner: socket, room })
          broadcast({ type: message.type, roomInfo: room, timestamp: now() })
        } else if (message.type === 'UNREGISTER_ROOM') {
          if (rooms.get(message.roomId)?.owner === socket) remove(message.roomId)
        }
      } catch {}
    })
    socket.on('close', () => {
      clients.delete(socket)
      for (const [code, entry] of rooms) if (entry.owner === socket) remove(code)
    })
  })
  const timer = pruneIntervalMs > 0 ? setInterval(prune, pruneIntervalMs) : null
  timer?.unref()
  return { prune, close() { if (timer) clearInterval(timer); rooms.clear(); clients.clear() } }
}
