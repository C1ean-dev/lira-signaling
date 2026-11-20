import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createNativeUpdates, releaseUpdate, INSTALLER } from '../nativeUpdates.mjs'

const binary = Buffer.from('MZ-installer-fixture')
const release = () => ({ tag_name: 'v0.1.1', draft: false, prerelease: false, assets: [{ id: 42, state: 'uploaded', name: INSTALLER,
  size: binary.length, digest: `sha256:${createHash('sha256').update(binary).digest('hex')}` }] })

test('only complete stable releases with the native Windows installer are offered', () => {
  assert.equal(releaseUpdate(release(), 'https://updates.test').version, '0.1.1')
  for (const change of [{ draft: true }, { prerelease: true }, { tag_name: 'v0.1.1-beta' }, { assets: [] }]) {
    assert.equal(releaseUpdate({ ...release(), ...change }, 'https://updates.test'), null)
  }
  const malformed = release(); malformed.assets[0].digest = null
  assert.equal(releaseUpdate(malformed, 'https://updates.test'), null)
})

test('private release assets redirect to GitHub signed CDN without proxying bytes or leaking the bot token', async t => {
  const signedUrl = 'https://release-assets.githubusercontent.com/file.exe?signature=abc'
  const calls = []
  const service = createNativeUpdates({ env: { GITHUB_RELEASES_TOKEN: 'private-token' }, baseUrl: 'https://updates.test', fetch: async url => {
    calls.push(url)
    if (url.includes('/releases?')) return new Response(JSON.stringify([release()]))
    if (url.includes('/releases/assets/')) return new Response(null, { status: 302, headers: { location: signedUrl } })
    throw new Error(`server must not download signed binary directly in redirect mode: ${url}`)
  } })
  const server = createServer((req, res) => {
    if (req.url === '/latest') return service.latest(req, res)
    req.params = { assetId: req.url.slice(1) }; return service.asset(req, res)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`
  const metadata = await (await fetch(origin + '/latest')).json()
  assert.equal(JSON.stringify(metadata).includes('private-token'), false)
  const asset = await fetch(origin + '/42', { redirect: 'manual' })
  assert.equal(asset.status, 302)
  assert.equal(asset.headers.get('location'), signedUrl)
  assert.equal(asset.headers.get('cache-control'), 'no-store')
  assert.equal(asset.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(calls.some(url => url.startsWith('https://release-assets.githubusercontent.com')), false)
  assert.equal((await fetch(origin + '/43', { redirect: 'manual' })).status, 404)
})

test('rejects untrusted redirect targets for private release assets', async t => {
  const service = createNativeUpdates({ env: { GITHUB_RELEASES_TOKEN: 'private-token' }, baseUrl: 'https://updates.test', fetch: async url => {
    if (url.includes('/releases?')) return new Response(JSON.stringify([release()]))
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/file.exe' } })
  } })
  const server = createServer((req, res) => {
    req.params = { assetId: req.url.slice(1) }; return service.asset(req, res)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`
  const asset = await fetch(origin + '/42', { redirect: 'manual' })
  assert.equal(asset.status, 503)
  assert.equal(asset.headers.get('location'), null)
})

test('optional proxy fallback streams private installer without forwarding the bot token', async t => {
  let rawHeaders
  const service = createNativeUpdates({ env: { GITHUB_RELEASES_TOKEN: 'private-token', LIRA_NATIVE_UPDATES_PROXY: '1' }, baseUrl: 'https://updates.test', fetch: async (url, options) => {
    if (url.includes('/releases?')) return new Response(JSON.stringify([release()]))
    if (url.includes('/releases/assets/')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file.exe?signature=abc' } })
    rawHeaders = options.headers
    return new Response(binary)
  } })
  const server = createServer((req, res) => {
    req.params = { assetId: req.url.slice(1) }; return service.asset(req, res)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`
  assert.deepEqual(Buffer.from(await (await fetch(origin + '/42')).arrayBuffer()), binary)
  assert.equal(rawHeaders, undefined)
})
