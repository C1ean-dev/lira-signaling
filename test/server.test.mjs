import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import WebSocket from 'ws'
import { generateKeyPairSync, sign } from 'node:crypto'

test('serves room discovery and existing PeerJS signaling on the same port', { timeout: 20000 }, async t => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const catalog = Buffer.from(JSON.stringify({ version: 1, revision: 1, expires: Math.floor(Date.now() / 1000) + 3600, nodes: [] }))
  const manifest = { payload: catalog.toString('base64url'), signature: sign(null, catalog, privateKey).toString('base64url') }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('../', import.meta.url), env: { ...process.env, CLOUDFLARE_TURN_KEY_ID: '', CLOUDFLARE_TURN_API_TOKEN: '', PORT: '0',
      LIRA_P2P_CATALOG_KEY: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
      LIRA_P2P_BOOTSTRAP_MANIFEST: JSON.stringify(manifest),
    }, windowsHide: true,
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
  const bootstrap = await fetch(`http://127.0.0.1:${port}/p2p/bootstrap/v1`)
  assert.equal(bootstrap.status, 200)
  assert.deepEqual(await bootstrap.json(), manifest)
  const turn = await fetch(`http://127.0.0.1:${port}/turn/credentials`)
  assert.equal(turn.status, 503)
  assert.equal(turn.headers.get('cache-control'), 'no-store')
  const preflight = await fetch(`http://127.0.0.1:${port}/turn/credentials`, { method: 'OPTIONS' })
  assert.equal(preflight.status, 204)
  const response = once(discovery.socket, 'message')
  discovery.socket.send(JSON.stringify({ type: 'ANNOUNCE_ROOM', roomInfo: {
    id: 'test', code: 'TEST', name: 'Public room', hostId: 'test-peer', hostName: 'Ana', playerCount: 1, maxPlayers: 12, color: '#fff',
  } }))
  assert.equal(JSON.parse(String((await response)[0])).type, 'ANNOUNCE_ROOM')
})
