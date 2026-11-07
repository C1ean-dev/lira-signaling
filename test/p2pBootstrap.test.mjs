import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createP2pBootstrapHandler } from '../p2pBootstrap.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
const now = 1730000000000
function manifest(changes = {}) {
  const data = Buffer.from(JSON.stringify({ version: 1, revision: 1, expires: now / 1000 + 3600, nodes: [], ...changes }))
  return JSON.stringify({ payload: data.toString('base64url'), signature: sign(null, data, privateKey).toString('base64url') })
}
function request(env, method = 'GET') {
  const headers = {}
  const res = { statusCode: 200, setHeader(name, value) { headers[name] = value }, end(body = '') { this.body = body } }
  createP2pBootstrapHandler({ env, now: () => now })({ method }, res)
  return { ...res, headers }
}
test('serves only a verified, unexpired catalog and exposes no signing secrets', () => {
  const raw = manifest()
  const response = request({ LIRA_P2P_CATALOG_KEY: key, LIRA_P2P_BOOTSTRAP_MANIFEST: raw })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), JSON.parse(raw))
  assert.equal(response.headers['Cache-Control'], 'public, max-age=300')
})
test('rejects missing configuration, invalid signatures and expired catalogs', () => {
  for (const raw of [undefined, '{}', manifest({ expires: now / 1000 }), manifest().replace('"signature":"', '"signature":"A')]) {
    const response = request({ LIRA_P2P_CATALOG_KEY: key, LIRA_P2P_BOOTSTRAP_MANIFEST: raw })
    assert.equal(response.statusCode, 503)
    assert.equal(response.headers['Cache-Control'], 'no-store')
  }
})
test('supports CORS preflight and rejects writes', () => {
  assert.equal(request({}, 'OPTIONS').statusCode, 204)
  const response = request({}, 'POST')
  assert.equal(response.statusCode, 405)
  assert.equal(response.headers.Allow, 'GET, OPTIONS')
})
