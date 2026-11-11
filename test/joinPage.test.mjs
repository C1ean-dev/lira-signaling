import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { once } from 'node:events'
import { createJoinPageRouter } from '../joinPage.js'
import { nativeInviteLink, readInvitation } from '../join-page/invite.js'

const encode = (prefix, data) => prefix + Buffer.from(JSON.stringify(data)).toString('base64url')
const fragment = value => '#invite=' + encodeURIComponent(value)
const offer = now => ({ version: 1, kind: 'offer', room: 'ROOM', session: 'test-session', host: 'lira-ROOM-host',
  guest: 'lira-ROOM-peer-Guest', expiresAt: now + 600000, description: { type: 'offer', sdp: 'v=0\r\na=MixedCASE+/-_\r\n' } })

test('the isolated HTTPS bridge serves its page and assets without adding state or touching other routes', async t => {
  const app = express()
  app.use('/join', createJoinPageRouter())
  app.get('/existing', (_req, res) => res.json({ ok: true }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const origin = `http://127.0.0.1:${server.address().port}`
  const response = await fetch(origin + '/join')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/html/)
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  const html = await response.text()
  assert.match(html, /Abrir no Lira/)
  assert.match(html, /https:\/\/github.com\/C1ean-dev\/Lira\/releases\/latest/)
  assert.match(html, /property="og:title"/)
  for (const file of ['invite.js', 'invite.css', 'logo.svg']) assert.equal((await fetch(origin + '/join/' + file)).status, 200)
  const head = await fetch(origin + '/join', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  assert.equal((await fetch(origin + '/join', { method: 'POST' })).status, 405)
  assert.equal((await fetch(origin + '/join/unrecognized')).status, 404)
  assert.deepEqual(await (await fetch(origin + '/existing')).json(), { ok: true })
})

test('the bridge preserves a complete invitation with all its case-sensitive routes', () => {
  const now = Date.now()
  const invite = encode('LIRA-ALL:', { version: 1, room: 'ROOM', signaling: 'render',
    ipv6: { addresses: ['[2001:db8::20]'], port: 9000 }, direct: offer(now) })
  assert.equal(readInvitation(fragment(invite), now), invite)
  assert.equal(new URL(nativeInviteLink(invite)).searchParams.get('invite'), invite)
  // A route through signaling remains usable after the direct offer expires.
  assert.equal(readInvitation(fragment(invite), now + 600001), invite)
})

test('direct-only invitations expire and plain room codes remain available after installation', () => {
  const now = Date.now()
  const invite = encode('LIRA-ALL:', { version: 1, room: 'ROOM', direct: offer(now) })
  assert.equal(readInvitation(fragment(invite), now), invite)
  assert.throws(() => readInvitation(fragment(invite), now + 600001), /expirou/)
  assert.equal(readInvitation('#invite=ROOM-42', now + 600001), 'ROOM-42')
  const lan = encode('LIRA-LAN:', { room: 'ROOM', host: '[2001:db8::20]', port: 9000 })
  assert.equal(readInvitation(fragment(lan), now), lan)
  const direct = encode('LIRA-DIRECT:', offer(now))
  assert.equal(readInvitation(fragment(direct), now), direct)
})

test('untrusted fragments cannot select another protocol, inject markup or start recursive invitations', () => {
  for (const value of ['', '#invite=', '#invite=ROOM&invite=OTHER', '#invite=ROOM&url=https://example.org',
    '#invite=javascript:alert(1)', '#invite=<script>', '#invite=lira://join?invite=ROOM',
    '#invite=LIRA-ALL:broken', '#invite=' + 'x'.repeat(30000)]) {
    assert.throws(() => readInvitation(value), /inválido/)
  }
  assert.throws(() => readInvitation(fragment(encode('LIRA-LAN:', { room: 'ROOM', host: 'evil/path', port: 9000 }))), /inválido/)
  assert.throws(() => readInvitation(fragment(encode('LIRA-DIRECT:', { ...offer(Date.now()), kind: 'answer' }))), /inválido/)
})
