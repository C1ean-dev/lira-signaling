import { randomUUID } from 'node:crypto'

const EXCHANGE = 'lira.public-rooms.v1'
const TTL_MS = 20000
const MAX_BYTES = 16 * 1024
const TYPES = new Set(['QUERY_ROOMS', 'ANNOUNCE_ROOM', 'HEARTBEAT', 'UNREGISTER_ROOM'])

// Server-only credentials. Never return the URL or raw connection errors to clients.
export function createAmqpRoomsRelay({
  url, origin = randomUUID(),
  connect = async (...args) => (await import('amqplib')).default.connect(...args),
  retryMs = 5000, timeoutMs = 7000, confirmTimeoutMs = 5000,
} = {}) {
  let endpoint
  try {
    endpoint = new URL(url)
    if (endpoint.protocol !== 'amqps:') throw new Error()
  } catch { throw new Error('CLOUDAMQP_URL must be a valid amqps URL') }
  endpoint.searchParams.set('heartbeat', '30')
  let status = 'connecting'
  let current = null
  let retryTimer = null
  let stopped = false
  const statusListeners = new Set()
  const messageListeners = new Set()
  const getStatus = () => ({ name: 'RabbitMQ', host: endpoint.hostname, status })
  const setStatus = next => {
    if (status === next) return
    status = next
    statusListeners.forEach(listener => listener(getStatus()))
  }
  const dispose = session => {
    clearTimeout(session.timer)
    session.pending.forEach(finish => finish(false))
    session.pending.clear()
    return Promise.resolve(session.connection?.close()).catch(() => {})
  }
  const fail = session => {
    if (current !== session) return
    current = null
    void dispose(session)
    setStatus('disconnected')
    if (!stopped) {
      retryTimer = setTimeout(() => { retryTimer = null; void start() }, retryMs)
      retryTimer.unref?.()
    }
  }
  const start = async () => {
    if (stopped) return
    const session = { connection: null, channel: null, pending: new Set(), blocked: false, timer: null }
    current = session
    setStatus('connecting')
    session.timer = setTimeout(() => fail(session), timeoutMs)
    session.timer.unref?.()
    const check = () => { if (current !== session || stopped) throw new Error('Connection cancelled') }
    try {
      session.connection = await connect(endpoint.toString(), { timeout: timeoutMs })
      if (current !== session || stopped) { await dispose(session); return }
      session.connection.on('error', () => fail(session))
      session.connection.on('close', () => fail(session))
      const channel = session.channel = await session.connection.createConfirmChannel()
      check()
      channel.on('error', () => fail(session))
      channel.on('close', () => fail(session))
      channel.on('drain', () => { session.blocked = false })
      await channel.assertExchange(EXCHANGE, 'fanout', { durable: true })
      check()
      const { queue } = await channel.assertQueue('', {
        exclusive: true, autoDelete: true, durable: false,
        arguments: { 'x-message-ttl': TTL_MS, 'x-max-length': 1000 },
      })
      check()
      await channel.bindQueue(queue, EXCHANGE, '')
      check()
      await channel.consume(queue, packet => {
        if (current !== session) return
        if (!packet) { fail(session); return }
        try {
          if (packet.content.length > MAX_BYTES) return
          const event = JSON.parse(packet.content.toString('utf8'))
          const age = Date.now() - event.timestamp
          if (event.version !== 1 || typeof event.origin !== 'string' || !event.origin || event.origin.length > 128 ||
            event.origin === origin || !Number.isFinite(age) || age < -5000 || age >= TTL_MS || !TYPES.has(event.message?.type)) return
          messageListeners.forEach(listener => listener(event.message, event.origin))
        } catch {}
      }, { noAck: true })
      check()
      clearTimeout(session.timer)
      setStatus('connected')
    } catch { fail(session) }
  }
  void start()
  return {
    getStatus,
    subscribeStatus(listener) { statusListeners.add(listener); listener(getStatus()); return () => statusListeners.delete(listener) },
    onMessage(listener) { messageListeners.add(listener); return () => messageListeners.delete(listener) },
    async publish(message) {
      const session = current
      if (status !== 'connected' || !session?.channel || session.blocked || session.pending.size >= 128 || !TYPES.has(message?.type)) return false
      let content
      try { content = Buffer.from(JSON.stringify({ version: 1, origin, timestamp: Date.now(), message })) } catch { return false }
      if (content.length > MAX_BYTES) return false
      return new Promise(resolve => {
        let timer
        let settled = false
        const finish = confirmed => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          session.pending.delete(finish)
          resolve(confirmed && current === session && !stopped)
        }
        session.pending.add(finish)
        timer = setTimeout(() => fail(session), confirmTimeoutMs)
        timer.unref?.()
        try {
          session.blocked = !session.channel.publish(EXCHANGE, '', content, {
            contentType: 'application/json', expiration: String(TTL_MS), persistent: false,
          }, error => finish(!error))
        } catch { fail(session) }
      })
    },
    async close() {
      stopped = true
      clearTimeout(retryTimer)
      const session = current
      current = null
      setStatus('disconnected')
      statusListeners.clear()
      messageListeners.clear()
      if (session) await dispose(session)
    },
  }
}
