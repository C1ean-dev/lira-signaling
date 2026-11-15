import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import express from 'express'
import { createLiraUpdates, UPDATE_INTERVAL_MS } from '../liraUpdates.mjs'

const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`
function release(version = 1) {
  const binary = Buffer.from(`MZ-Lira-installer-${version}`)
  const apk = Buffer.from(`APK-Lira-${version}`)
  return { tag_name: `v1.0.${version}`, name: 'Lira', body: 'Melhorias', draft: false, prerelease: false,
    assets: [{ id: version * 10, name: `Lira.Setup.1.0.${version}.exe`, state: 'uploaded', size: binary.length, digest: digest(binary) },
      { id: version * 10 + 1, name: `Lira-v1.0.${version}.apk`, state: 'uploaded', size: apk.length, digest: digest(apk) }], binary, apk }
}
async function fixture(t, publishToken = 'publisher-secret') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lira-cache-test-'))
  const calls = []; const warnings = []
  let clock = 1794400000000; let latest = release(); let offline = false; let badBinary = false; let signedHeaders; let metadataGate
  const fetcher = async (url, options) => {
    calls.push(url)
    if (offline) throw new Error('private upstream response must not leak')
    if (url.endsWith('/releases/latest')) { if (metadataGate) await metadataGate; return Response.json(latest) }
    if (url.includes('/releases/assets/')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/' + url.split('/').at(-1) } })
    signedHeaders = options.headers
    return new Response(badBinary ? Buffer.from('invalid') : url.endsWith(String(latest.assets[0].id)) ? latest.binary : latest.apk)
  }
  const make = () => createLiraUpdates({ directory, fetch: fetcher, now: () => clock, env: { GITHUB_RELEASES_TOKEN: 'test-secret', LIRA_UPDATE_PUBLISH_TOKEN: publishToken }, warn: line => warnings.push(line) })
  let cache = make()
  const app = express()
  app.use('/updates/lira', (req, res, next) => cache.router(req, res, next))
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}/updates/lira`
  t.after(async () => {
    cache.close(); await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(directory), os.tmpdir())
    assert.ok(path.basename(directory).startsWith('lira-cache-test-'))
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return { calls, warnings, directory, origin, get cache() { return cache }, get latest() { return latest },
    advance: () => { clock += UPDATE_INTERVAL_MS }, setRelease: value => { latest = value },
    offline: () => { offline = true }, online: () => { offline = false }, badBinary: () => { badBinary = true }, signedHeaders: () => signedHeaders,
    blockMetadata: () => { let finish; metadataGate = new Promise(resolve => { finish = resolve }); return () => { finish(); metadataGate = null } },
    restart: () => { cache.close(); cache = make() } }
}

const publish = (origin, tag = 'v1.0.2', token = 'publisher-secret') => fetch(origin + '/refresh', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ tag_name: tag }),
})

test('authenticated publication refreshes both installers immediately and is idempotent', async t => {
  const f = await fixture(t)
  await f.cache.refresh()
  f.setRelease(release(2))
  const response = await publish(f.origin)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'ready', tag_name: 'v1.0.2' })
  assert.equal((await (await fetch(f.origin + '/latest')).json()).tag_name, 'v1.0.2')
  assert.deepEqual(Buffer.from(await (await fetch(f.origin + '/assets/21')).arrayBuffer()), f.latest.apk)
  const count = f.calls.length
  assert.equal((await publish(f.origin)).status, 200)
  assert.equal(f.calls.length, count)
  await f.cache.refresh()
  assert.equal(f.calls.length, count, 'normal checks still respect the daily interval')
})

test('publication requires a configured secret and rejects unauthorized or invalid requests before fetching', async t => {
  const f = await fixture(t)
  for (const token of ['', 'wrong', 'test-secret']) assert.equal((await publish(f.origin, 'v1.0.2', token)).status, 401)
  assert.equal((await publish(f.origin, '../invalid')).status, 400)
  assert.equal(f.calls.length, 0)
  const unconfigured = await fixture(t, '')
  assert.equal((await publish(unconfigured.origin)).status, 503)
  assert.equal(unconfigured.calls.length, 0)
})

test('failed or mismatched publication preserves the previous verified release and can retry immediately', async t => {
  const f = await fixture(t)
  await f.cache.refresh()
  assert.equal((await publish(f.origin)).status, 502, 'latest GitHub release must match the requested tag')
  const bad = release(2); bad.assets[1].digest = 'sha256:' + '0'.repeat(64)
  f.setRelease(bad)
  const failed = await publish(f.origin)
  assert.equal(failed.status, 502)
  assert.equal((await failed.text()).includes('secret'), false)
  assert.equal((await (await fetch(f.origin + '/latest')).json()).tag_name, 'v1.0.1')
  f.setRelease(release(2))
  assert.equal((await publish(f.origin)).status, 200)
})

test('downloads and verifies both installers once, then serves repeated checks and downloads from disk', async t => {
  const f = await fixture(t)
  await Promise.all(Array.from({ length: 10 }, () => f.cache.refresh()))
  assert.equal(f.calls.filter(url => url.endsWith('/latest')).length, 1)
  assert.equal(f.calls.length, 5)
  assert.equal(f.signedHeaders(), undefined, 'credentials must not follow the CDN redirect')
  const info = await (await fetch(f.origin + '/latest')).json()
  assert.equal(info.tag_name, 'v1.0.1')
  assert.equal(info.assets[0].browser_download_url, 'https://lira-signaling.onrender.com/updates/lira/assets/10')
  assert.equal(JSON.stringify(info).includes('test-secret'), false)
  assert.equal(JSON.stringify(info).includes(f.directory), false)
  f.offline()
  for (let i = 0; i < 3; i++) {
    assert.equal((await fetch(f.origin + '/latest')).status, 200)
    assert.deepEqual(Buffer.from(await (await fetch(f.origin + '/assets/10')).arrayBuffer()), f.latest.binary)
  }
  assert.equal(f.calls.filter(url => url.endsWith('/latest')).length, 5, 'each client request checks GitHub metadata')
  assert.equal(f.calls.filter(url => !url.endsWith('/latest')).length, 4, 'cached installers are not downloaded again')
  const range = await fetch(f.origin + '/assets/10', { headers: { Range: 'bytes=0-1' } })
  assert.equal(range.status, 206)
  assert.equal(await range.text(), 'MZ')
  assert.equal((await fetch(f.origin + '/assets/999')).status, 404)
  assert.equal((await fetch(f.origin + '/latest', { method: 'OPTIONS' })).status, 204)
})

test('background checks respect the daily interval while client checks bypass it across failure and restart', async t => {
  const f = await fixture(t)
  await f.cache.refresh()
  await f.cache.refresh()
  assert.equal(f.calls.length, 5)
  f.advance(); f.offline()
  await f.cache.refresh()
  assert.equal(f.calls.length, 6)
  assert.equal(f.warnings.length, 1)
  f.restart()
  const info = await (await fetch(f.origin + '/latest')).json()
  assert.equal(info.tag_name, 'v1.0.1')
  assert.equal(info.stale, true)
  assert.equal((await fetch(f.origin + '/assets/10')).status, 200)
  await f.cache.refresh()
  assert.equal(f.calls.length, 7, 'client requests bypass the persisted daily check time, while background checks respect it')
})

test('publishes the new release only after verification and bounds retained installers to two generations', async t => {
  const f = await fixture(t)
  await f.cache.refresh()
  f.advance(); f.setRelease(release(2)); await f.cache.refresh()
  assert.equal((await (await fetch(f.origin + '/latest')).json()).tag_name, 'v1.0.2')
  assert.equal((await fetch(f.origin + '/assets/10')).status, 200, 'a client holding the previous link can finish updating')
  f.advance(); f.setRelease(release(3)); await f.cache.refresh()
  assert.equal((await fetch(f.origin + '/assets/10')).status, 404)
  assert.equal((await fetch(f.origin + '/assets/20')).status, 200)
  assert.equal((await fs.readdir(f.directory)).filter(file => file.endsWith('.bin')).length, 4)
})

test('rejects incomplete or corrupt downloads without replacing the working cache', async t => {
  const f = await fixture(t)
  await f.cache.refresh()
  const badApk = release(2); badApk.assets[1].digest = 'sha256:' + '0'.repeat(64)
  f.advance(); f.setRelease(badApk); await f.cache.refresh()
  assert.equal((await (await fetch(f.origin + '/latest')).json()).tag_name, 'v1.0.1')
  assert.equal((await fetch(f.origin + '/assets/20')).status, 404)
  assert.equal((await fs.readdir(f.directory)).filter(file => file.endsWith('.bin')).length, 2, 'the first verified file is removed if the second file prevents publication')
  f.advance(); f.setRelease(release(3)); f.badBinary(); await f.cache.refresh()
  assert.equal((await (await fetch(f.origin + '/latest')).json()).tag_name, 'v1.0.1')
  assert.equal((await fs.readdir(f.directory)).some(file => file.endsWith('.tmp')), false)
})

test('does not advertise an update when there is no valid cached installer', async t => {
  const f = await fixture(t); f.offline()
  await f.cache.refresh()
  const response = await fetch(f.origin + '/latest')
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('retry-after'), '30')
  const body = await response.json()
  assert.equal(body.error, 'update_cache_unavailable')
  assert.equal(body.status, 'unavailable')
  assert.deepEqual(body.failure, { stage: 'release_metadata', code: 'cache_refresh_failed' })
  assert.equal(JSON.stringify(body).includes('private upstream response'), false)
  assert.equal(f.calls.length, 2, 'a client check retries failed initialization immediately')
})

test('reports only sanitized upstream status and stage when GitHub rejects the initial request', async t => {
  const f = await fixture(t)
  let authorization
  const cache = createLiraUpdates({ env: { GITHUB_REPORT_TOKEN: 'existing-server-credential' }, directory: path.join(f.directory, 'http-failure'), warn: () => {},
    fetch: async (_url, options) => { authorization = options.headers.Authorization; return new Response('sensitive upstream body', { status: 403 }) } })
  await cache.refresh()
  const app = express(); app.use(cache.router)
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => server.close())
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/latest`)).json()
  assert.deepEqual(body.failure, { stage: 'release_metadata', code: 'GITHUB_HTTP_403' })
  assert.equal(authorization, 'Bearer existing-server-credential')
  assert.equal(JSON.stringify(body).includes('sensitive'), false)
  assert.equal(JSON.stringify(body).includes('existing-server-credential'), false)
})

test('rejects a matching-length checksum failure and untrusted download redirects', async t => {
  const f = await fixture(t)
  const value = release(); value.assets[0].digest = 'sha256:' + '0'.repeat(64)
  f.setRelease(value); await f.cache.refresh()
  assert.equal((await fetch(f.origin + '/latest')).status, 503)
  const other = createLiraUpdates({ directory: path.join(f.directory, 'untrusted'), env: {}, warn: () => {},
    fetch: async url => url.endsWith('/latest') ? Response.json(release()) : new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) })
  await other.refresh()
  assert.equal((await fs.readdir(path.join(f.directory, 'untrusted'))).some(file => file.endsWith('.bin')), false)
})

test('every client check consults GitHub immediately, keeps equal versions and downloads only newer releases', async t => {
  const f = await fixture(t)
  const first = await fetch(f.origin + '/latest')
  assert.equal(first.status, 200, 'the initial request waits for verified installers')
  assert.equal((await first.json()).tag_name, 'v1.0.1')
  assert.equal(f.calls.length, 5)
  for (let i = 0; i < 2; i++) {
    const same = await (await fetch(f.origin + '/latest')).json()
    assert.equal(same.tag_name, 'v1.0.1')
    assert.equal(same.stale, false)
  }
  assert.equal(f.calls.length, 7, 'equal versions only fetch metadata')
  f.setRelease(release(2))
  const newer = await (await fetch(f.origin + '/latest')).json()
  assert.equal(newer.tag_name, 'v1.0.2', 'the request gets the new version without waiting 24 hours')
  assert.equal(f.calls.length, 12)
  assert.deepEqual(Buffer.from(await (await fetch(f.origin + '/assets/20')).arrayBuffer()), f.latest.binary)
  f.setRelease(release(1))
  const older = await (await fetch(f.origin + '/latest')).json()
  assert.equal(older.tag_name, 'v1.0.2', 'an older upstream version never rolls back the cache')
  assert.equal(f.calls.length, 13)
})

test('an equal version preserves its verified installers even when GitHub replaces asset metadata', async t => {
  const f = await fixture(t)
  await f.cache.refresh()
  const replaced = release(1)
  replaced.assets[0].id = 999
  f.setRelease(replaced)
  const info = await (await fetch(f.origin + '/latest')).json()
  assert.equal(info.assets[0].id, 10)
  assert.equal(f.calls.length, 6)
})

test('a failed client refresh marks the cache stale and the next client retries immediately', async t => {
  const f = await fixture(t)
  await f.cache.refresh()
  f.offline()
  const failed = await (await fetch(f.origin + '/latest')).json()
  assert.equal(failed.stale, true, 'clients must be able to fall back to GitHub instead of trusting an unverified cache')
  assert.equal(failed.tag_name, 'v1.0.1')
  assert.equal((await fetch(f.origin + '/assets/10')).status, 200)
  f.online(); f.setRelease(release(2))
  const retry = await (await fetch(f.origin + '/latest')).json()
  assert.equal(retry.tag_name, 'v1.0.2')
  assert.equal(retry.stale, false)
})

test('concurrent client checks share one refresh and all wait for the verified newer version', async t => {
  const f = await fixture(t)
  await f.cache.refresh()
  f.setRelease(release(2))
  const unblock = f.blockMetadata()
  const before = f.calls.length
  const responses = Array.from({ length: 10 }, () => fetch(f.origin + '/latest').then(response => response.json()))
  // Let all requests reach the blocked metadata fetch before releasing it.
  try {
    for (let i = 0; i < 100 && f.calls.length === before; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(f.calls.length, before + 1)
    await new Promise(resolve => setTimeout(resolve, 30))
  } finally { unblock() }
  for (const response of await Promise.all(responses)) assert.equal(response.tag_name, 'v1.0.2')
  assert.equal(f.calls.length, before + 5)
})

test('authenticated publication can complete a partially cached release without downloading its EXE again', async t => {
  const f = await fixture(t)
  const partial = release(1)
  partial.assets = partial.assets.slice(0, 1)
  f.setRelease(partial)
  await f.cache.refresh()
  assert.equal(f.calls.length, 3)
  f.setRelease(release(1))
  const response = await publish(f.origin, 'v1.0.1')
  assert.equal(response.status, 200)
  assert.equal(f.calls.length, 6, 'only metadata and the missing APK are fetched')
  assert.equal((await (await fetch(f.origin + '/latest')).json()).assets.length, 2)
})
