import test from 'node:test'
import assert from 'node:assert/strict'
import { createTurnCredentialsHandler } from '../turnCredentials.js'

const env = { CLOUDFLARE_TURN_KEY_ID: 'test-key-id', CLOUDFLARE_TURN_API_TOKEN: 'server-only-test-token' }
const iceServers = [{ urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: 'temporary-user', credential: 'temporary-password' }]
const request = { method: 'GET', ip: 'test-client' }
function response() {
  return { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value }, end(body) { this.body = body ? JSON.parse(body) : null } }
}

test('generates expiring credentials server-side and returns only client ICE settings', async () => {
  const calls = []
  const handler = createTurnCredentialsHandler({ env, now: () => 1000, fetch: async (...args) => { calls.push(args); return { ok: true, json: async () => ({ iceServers, secret: 'never-return' }) } } })
  const res = response()
  await handler(request, res)
  assert.equal(calls[0][0], 'https://rtc.live.cloudflare.com/v1/turn/keys/test-key-id/credentials/generate-ice-servers')
  assert.equal(calls[0][1].headers.Authorization, 'Bearer server-only-test-token')
  assert.deepEqual(JSON.parse(calls[0][1].body), { ttl: 86400 })
  assert.ok(calls[0][1].signal instanceof AbortSignal)
  assert.deepEqual(res.body, { iceServers, expiresAt: 86401000 })
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal(JSON.stringify(res.body).includes(env.CLOUDFLARE_TURN_API_TOKEN), false)
})

test('keeps secrets out of upstream and configuration errors', async () => {
  for (const options of [
    { env: {} },
    { env, fetch: async () => { throw new Error(env.CLOUDFLARE_TURN_API_TOKEN) } },
    { env, fetch: async () => ({ ok: false }) },
    { env, fetch: async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: 'https://bad.example' }] }) }) },
  ]) {
    const res = response()
    await createTurnCredentialsHandler(options)(request, res)
    assert.ok([502, 503].includes(res.statusCode))
    assert.equal(JSON.stringify(res.body).includes(env.CLOUDFLARE_TURN_API_TOKEN), false)
  }
})

test('limits credential issuance per client, permits preflight, and rejects writes', async () => {
  let calls = 0
  let now = 0
  const handler = createTurnCredentialsHandler({ env, now: () => now, fetch: async () => { calls++; return { ok: true, json: async () => ({ iceServers }) } } })
  for (let i = 0; i < 10; i++) await handler(request, response())
  const limited = response()
  await handler(request, limited)
  assert.equal(limited.statusCode, 429)
  assert.equal(calls, 10)
  await handler({ ...request, ip: 'other-client' }, response())
  assert.equal(calls, 11)
  now = 60001
  await handler(request, response())
  assert.equal(calls, 12)
  const preflight = response()
  await handler({ ...request, method: 'OPTIONS' }, preflight)
  assert.equal(preflight.statusCode, 204)
  const write = response()
  await handler({ ...request, method: 'POST' }, write)
  assert.equal(write.statusCode, 405)
  assert.equal(calls, 12)
})
