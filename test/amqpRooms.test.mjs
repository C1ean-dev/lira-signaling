import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createAmqpRoomsRelay } from '../amqpRooms.js'

const flush = () => new Promise(resolve => setImmediate(resolve))
function fixture(t, options = {}) {
  const channel = new EventEmitter()
  const connection = new EventEmitter()
  const sent = []
  let consume
  channel.assertExchange = async (...args) => { channel.exchange = args }
  channel.assertQueue = async (...args) => { channel.queue = args; return { queue: 'test-queue' } }
  channel.bindQueue = async () => {}
  channel.consume = async (_queue, callback) => { consume = callback }
  channel.publish = (...args) => { sent.push(args); return true }
  channel.close = async () => {}
  connection.createConfirmChannel = async () => channel
  connection.close = async () => { connection.closed = true }
  const calls = []
  const relay = createAmqpRoomsRelay({
    url: 'amqps://test:secret@broker.example/test', origin: 'this-server',
    connect: async (...args) => { calls.push(args); return connection },
    ...options,
  })
  t.after(() => relay.close())
  return { relay, channel, connection, sent, calls,
    receive: event => consume({ content: Buffer.from(JSON.stringify(event)) }),
  }
}

test('connects with TLS, heartbeat and bounded ephemeral discovery queues', async t => {
  const { relay, channel, calls } = fixture(t)
  await flush()
  assert.equal(relay.getStatus().status, 'connected')
  assert.deepEqual(relay.getStatus(), { name: 'RabbitMQ', host: 'broker.example', status: 'connected' })
  assert.ok(calls[0][0].startsWith('amqps://'))
  assert.ok(calls[0][0].includes('heartbeat=30'))
  assert.equal(channel.exchange[1], 'fanout')
  assert.equal(channel.queue[1].exclusive, true)
  assert.equal(channel.queue[1].arguments['x-message-ttl'], 20000)
})

test('reports publication only after confirmation and never queues while offline', async t => {
  const { relay, sent } = fixture(t)
  assert.equal(await relay.publish({ type: 'QUERY_ROOMS' }), false)
  await flush()
  let settled = false
  const result = relay.publish({ type: 'QUERY_ROOMS' }).then(value => { settled = true; return value })
  assert.equal(settled, false)
  assert.equal(sent.length, 1)
  assert.equal(JSON.parse(sent[0][2]).origin, 'this-server')
  assert.equal(sent[0][3].expiration, '20000')
  sent[0][4](null)
  assert.equal(await result, true)
})

test('ignores own echoes, expired, oversized and malformed messages', async t => {
  const { relay, receive } = fixture(t)
  const received = []
  relay.onMessage((message, origin) => received.push({ message, origin }))
  await flush()
  const event = { version: 1, origin: 'another-server', timestamp: Date.now(), message: { type: 'QUERY_ROOMS' } }
  receive({ ...event, origin: 'this-server' })
  receive({ ...event, timestamp: Date.now() - 21000 })
  receive({ ...event, message: { data: 'x'.repeat(20000) } })
  receive({ version: 999 })
  receive(event)
  assert.deepEqual(received, [{ message: event.message, origin: 'another-server' }])
})

test('recovers after channel failure, invalidates pending confirmations and closes cleanly', async t => {
  const { relay, channel, sent } = fixture(t, { retryMs: 5 })
  await flush()
  const pending = relay.publish({ type: 'QUERY_ROOMS' })
  channel.emit('error', new Error('credentials must not be logged'))
  assert.equal(relay.getStatus().status, 'disconnected')
  assert.equal(await pending, false)
  sent[0][4](null)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(relay.getStatus().status, 'connected')
  await relay.close()
  assert.equal(relay.getStatus().status, 'disconnected')
})

test('close during connection disposes a late response and never activates it', async t => {
  let resolve
  const connection = new EventEmitter()
  connection.close = async () => { connection.closed = true }
  const { relay } = fixture(t, { connect: () => new Promise(done => { resolve = done }) })
  await relay.close()
  resolve(connection)
  await flush()
  assert.equal(connection.closed, true)
  assert.equal(relay.getStatus().status, 'disconnected')
})

test('connection timeout releases initialization and retries without accepting late responses', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0
  let resolveFirst
  const { relay, connection } = fixture(t, {
    timeoutMs: 5, retryMs: 5,
    connect: () => { attempts++; return new Promise(resolve => { if (attempts === 1) resolveFirst = resolve }) },
  })
  t.mock.timers.tick(5)
  t.mock.timers.tick(5)
  assert.ok(attempts >= 2)
  resolveFirst(connection)
  await flush()
  assert.equal(connection.closed, true)
  assert.notEqual(relay.getStatus().status, 'connected')
})

test('confirmation timeout and broker rejection never claim a successful publication', async t => {
  const { relay, sent } = fixture(t, { confirmTimeoutMs: 5 })
  await flush()
  const rejected = relay.publish({ type: 'QUERY_ROOMS' })
  sent[0][4](new Error('rejected'))
  assert.equal(await rejected, false)
  const pending = relay.publish({ type: 'QUERY_ROOMS' })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(await pending, false)
  assert.equal(relay.getStatus().status, 'disconnected')
})

test('backpressure pauses publishing until drain and caps pending confirmations', async t => {
  const { relay, sent, channel } = fixture(t)
  await flush()
  channel.publish = (...args) => { sent.push(args); return false }
  const first = relay.publish({ type: 'QUERY_ROOMS' })
  assert.equal(await relay.publish({ type: 'QUERY_ROOMS' }), false)
  sent[0][4](null)
  assert.equal(await first, true)
  channel.emit('drain')
  channel.publish = (...args) => { sent.push(args); return true }
  const pending = Array.from({ length: 128 }, () => relay.publish({ type: 'QUERY_ROOMS' }))
  assert.equal(await relay.publish({ type: 'QUERY_ROOMS' }), false)
  await relay.close()
  assert.ok((await Promise.all(pending)).every(confirmed => !confirmed))
})
