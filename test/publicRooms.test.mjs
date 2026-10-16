import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createPublicRoomsHub } from '../publicRooms.js'

class Socket extends EventEmitter {
  readyState = 1
  messages = []
  send(data) { this.messages.push(JSON.parse(data)) }
  close() { this.readyState = 3; this.emit('close') }
  receive(data) { this.emit('message', typeof data === 'string' ? data : JSON.stringify(data)) }
}

const room = { id: 'room-TEST', code: 'TEST', name: 'Sala pública', hostId: 'peer-1', hostName: 'Ana', playerCount: 1, maxPlayers: 12, color: '#fff' }
function fixture(t) {
  let now = 100000
  const wss = new EventEmitter()
  const hub = createPublicRoomsHub(wss, { now: () => now, pruneIntervalMs: 0 })
  t.after(() => hub.close())
  const connect = () => { const socket = new Socket(); wss.emit('connection', socket); return socket }
  return { hub, connect, advance: ms => { now += ms } }
}

test('new clients receive protocol readiness and can query hosted rooms', t => {
  const { connect } = fixture(t)
  const host = connect()
  const viewer = connect()
  assert.equal(viewer.messages[0].type, 'READY')
  host.receive({ type: 'ANNOUNCE_ROOM', roomInfo: room })
  assert.equal(viewer.messages.at(-1).roomInfo.name, room.name)
  viewer.messages.length = 0
  viewer.receive({ type: 'QUERY_ROOMS' })
  assert.equal(viewer.messages.length, 1)
  assert.equal(viewer.messages[0].roomInfo.code, 'TEST')
})

test('keeps only whitelisted small metadata and ignores client heartbeat timestamps', t => {
  const { connect, advance, hub } = fixture(t)
  const host = connect()
  const viewer = connect()
  host.receive({ type: 'ANNOUNCE_ROOM', roomInfo: { ...room, hostAvatar: { customSkinUrl: 'x'.repeat(10000) }, unexpected: 'ignored', lastHeartbeat: Number.MAX_SAFE_INTEGER } })
  const metadata = viewer.messages.at(-1).roomInfo
  assert.equal(metadata.hostAvatar, undefined)
  assert.equal(metadata.unexpected, undefined)
  assert.equal(metadata.lastHeartbeat, 100000)
  advance(20001)
  hub.prune()
  assert.equal(viewer.messages.at(-1).type, 'UNREGISTER_ROOM')
})

test('heartbeats keep rooms alive and update participant counts', t => {
  const { connect, advance, hub } = fixture(t)
  const host = connect()
  const viewer = connect()
  host.receive({ type: 'ANNOUNCE_ROOM', roomInfo: room })
  advance(15000)
  host.receive({ type: 'HEARTBEAT', roomInfo: { ...room, playerCount: 4 } })
  advance(10000)
  hub.prune()
  viewer.messages.length = 0
  viewer.receive({ type: 'QUERY_ROOMS' })
  assert.equal(viewer.messages[0].roomInfo.playerCount, 4)
})

test('accepts empty optional descriptions and recovers a room after an expired heartbeat', t => {
  const { connect, advance, hub } = fixture(t)
  const host = connect()
  const viewer = connect()
  host.receive({ type: 'ANNOUNCE_ROOM', roomInfo: { ...room, description: '' } })
  assert.equal(viewer.messages.at(-1).roomInfo.code, 'TEST')
  advance(21000)
  hub.prune()
  host.receive({ type: 'HEARTBEAT', roomInfo: { ...room, description: '' } })
  viewer.messages.length = 0
  viewer.receive({ type: 'QUERY_ROOMS' })
  assert.equal(viewer.messages[0].roomInfo.code, 'TEST')
})

test('another connection cannot replace, refresh or remove an owned room', t => {
  const { connect } = fixture(t)
  const host = connect()
  const other = connect()
  host.receive({ type: 'ANNOUNCE_ROOM', roomInfo: room })
  other.receive({ type: 'ANNOUNCE_ROOM', roomInfo: { ...room, name: 'forged' } })
  other.receive({ type: 'HEARTBEAT', roomInfo: { ...room, playerCount: 999 } })
  other.receive({ type: 'UNREGISTER_ROOM', roomId: 'TEST' })
  other.messages.length = 0
  other.receive({ type: 'QUERY_ROOMS' })
  assert.equal(other.messages.length, 1)
  assert.equal(other.messages[0].roomInfo.name, room.name)
  assert.equal(other.messages[0].roomInfo.playerCount, 1)
})

test('removes rooms on explicit removal and on connection close', t => {
  const { connect } = fixture(t)
  const host = connect()
  const viewer = connect()
  host.receive({ type: 'ANNOUNCE_ROOM', roomInfo: room })
  host.receive({ type: 'UNREGISTER_ROOM', roomId: 'TEST' })
  assert.equal(viewer.messages.at(-1).roomId, 'TEST')
  host.receive({ type: 'ANNOUNCE_ROOM', roomInfo: room })
  host.close()
  assert.equal(viewer.messages.at(-1).type, 'UNREGISTER_ROOM')
  viewer.messages.length = 0
  viewer.receive({ type: 'QUERY_ROOMS' })
  assert.deepEqual(viewer.messages, [])
})

test('handles invalid JSON and invalid room metadata without breaking future messages', t => {
  const { connect } = fixture(t)
  const host = connect()
  const viewer = connect()
  for (const message of ['{bad', 'null', { type: 'ANNOUNCE_ROOM', roomInfo: {} }, { type: 'ANNOUNCE_ROOM', roomInfo: { ...room, name: 'x'.repeat(2000) } }]) host.receive(message)
  viewer.messages.length = 0
  viewer.receive({ type: 'QUERY_ROOMS' })
  assert.deepEqual(viewer.messages, [])
  host.receive({ type: 'ANNOUNCE_ROOM', roomInfo: room })
  assert.equal(viewer.messages.at(-1).roomInfo.code, 'TEST')
})
