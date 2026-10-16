import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import WebSocket from 'ws'

test('serves room discovery and existing PeerJS signaling on the same port', { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('../', import.meta.url), env: { ...process.env, CLOUDAMQP_URL: '', PORT: '0' }, windowsHide: true,
  })
  const sockets = []
  t.after(async () => {
    sockets.forEach(socket => socket.terminate())
    if (child.exitCode === null) { child.kill(); await once(child, 'exit') }
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const port = await new Promise((resolve, reject) => {
    let output = ''
    child.stdout.on('data', data => {
      output += data
      const match = /ativo na porta (\d+)/.exec(output)
      if (match) resolve(Number(match[1]))
    })
    child.once('exit', code => reject(new Error(`Server exited (${code}): ${stderr}`)))
    child.once('error', reject)
  })
  const open = async path => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    sockets.push(socket)
    const first = once(socket, 'message')
    await once(socket, 'open')
    return { socket, first: JSON.parse(String((await first)[0])) }
  }
  const discovery = await open('/rooms')
  assert.equal(discovery.first.type, 'READY')
  const peer = await open('/peerjs?key=peerjs&id=test-peer&token=test-token')
  assert.equal(peer.first.type, 'OPEN')
  const http = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(http.status, 200)
  const response = once(discovery.socket, 'message')
  discovery.socket.send(JSON.stringify({ type: 'ANNOUNCE_ROOM', roomInfo: {
    id: 'test', code: 'TEST', name: 'Public room', hostId: 'test-peer', hostName: 'Ana', playerCount: 1, maxPlayers: 12, color: '#fff',
  } }))
  assert.equal(JSON.parse(String((await response)[0])).type, 'ANNOUNCE_ROOM')
})
