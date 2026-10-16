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

export function createPublicRoomsHub(wss, { now = Date.now, pruneIntervalMs = 5000, relay = null } = {}) {
  const rooms = new Map()
  const clients = new Set()
  let closed = false
  let relayGeneration = 0
  const send = (socket, message) => {
    if (socket.readyState !== 1) return
    try { socket.send(JSON.stringify(message)) } catch {}
  }
  const broadcast = message => clients.forEach(socket => send(socket, message))
  const publishRoom = (entry, type = 'ANNOUNCE_ROOM') => {
    if (!relay || entry.origin) return
    const generation = relayGeneration
    const room = entry.room
    void relay.publish({ type, roomInfo: room, timestamp: now() }).then(confirmed => {
      if (!confirmed || closed || generation !== relayGeneration || rooms.get(room.code) !== entry ||
        entry.room !== room || now() - room.lastHeartbeat >= ROOM_TTL_MS) return
      entry.confirmedAt = now()
      broadcast({ type: 'ROOM_PUBLISHED', service: 'RabbitMQ', roomId: room.code,
        hostId: room.hostId, announcementId: room.announcementId, timestamp: now() })
    }).catch(() => {})
  }
  const announcement = (entry, type = 'ANNOUNCE_ROOM') => ({
    type, roomInfo: entry.room, timestamp: now(),
    ...(entry.origin || (entry.confirmedAt !== undefined && now() - entry.confirmedAt < ROOM_TTL_MS)
      ? { publicationServices: ['RabbitMQ'] } : {}),
  })
  const remove = (code, forward = true) => {
    const entry = rooms.get(code)
    rooms.delete(code)
    const message = { type: 'UNREGISTER_ROOM', roomId: code, timestamp: now() }
    broadcast(message)
    if (forward && entry && !entry.origin) void relay?.publish(message).catch(() => {})
  }
  const prune = () => {
    for (const [code, entry] of rooms) if (now() - entry.room.lastHeartbeat > ROOM_TTL_MS) remove(code)
  }
  const unsubscribeMessage = relay?.onMessage((message, origin) => {
    if (closed) return
    prune()
    if (message.type === 'QUERY_ROOMS') {
      for (const entry of rooms.values()) publishRoom(entry)
    } else if (message.type === 'ANNOUNCE_ROOM' || message.type === 'HEARTBEAT') {
      const room = metadata(message.roomInfo, now())
      if (!room) return
      const existing = rooms.get(room.code)
      if (existing && existing.origin !== origin) return
      const entry = { room, origin }
      rooms.set(room.code, entry)
      broadcast(announcement(entry, message.type))
    } else if (message.type === 'UNREGISTER_ROOM' && rooms.get(message.roomId)?.origin === origin) {
      remove(message.roomId, false)
    }
  })
  const unsubscribeStatus = relay?.subscribeStatus(service => {
    relayGeneration++
    for (const entry of rooms.values()) entry.confirmedAt = undefined
    broadcast({ type: 'SERVICE_STATUS', services: [service] })
    if (service.status === 'connected') {
      void relay.publish({ type: 'QUERY_ROOMS', timestamp: now() }).catch(() => {})
      for (const entry of rooms.values()) publishRoom(entry)
    }
  })
  wss.on('connection', socket => {
    clients.add(socket)
    send(socket, { type: 'READY', protocolVersion: 1, ...(relay ? { services: [relay.getStatus()] } : {}) })
    socket.on('error', () => {})
    socket.on('message', data => {
      try {
        if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES) return
        const message = JSON.parse(String(data))
        if (!message || typeof message !== 'object') return
        prune()
        if (message.type === 'QUERY_ROOMS') {
          for (const entry of rooms.values()) send(socket, announcement(entry))
        } else if (message.type === 'ANNOUNCE_ROOM' || message.type === 'HEARTBEAT') {
          const room = metadata(message.roomInfo, now())
          if (!room) return
          const existing = rooms.get(room.code)
          if (existing && existing.owner !== socket) return
          // Each host connection advertises at most one room.
          for (const [code, entry] of rooms) if (entry.owner === socket && code !== room.code) remove(code)
          if (existing) room.createdAt = existing.room.createdAt
          const entry = { owner: socket, room }
          rooms.set(room.code, entry)
          broadcast(announcement(entry, message.type))
          publishRoom(entry, message.type)
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
  return { prune, close() {
    closed = true
    unsubscribeMessage?.()
    unsubscribeStatus?.()
    if (timer) clearInterval(timer)
    rooms.clear()
    clients.clear()
  } }
}
