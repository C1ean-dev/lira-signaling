import express from 'express'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Transform, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
const API = 'https://api.github.com/repos/C1ean-dev/Lira'
const VERSION = /^v?\d+\.\d+\.\d+$/
const MAX_ASSET_BYTES = 512 * 1024 * 1024
const BASE_URL = 'https://lira-signaling.onrender.com/updates/lira'
const validId = value => Number.isSafeInteger(value) && value > 0
const hashOf = async file => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export function createLiraUpdates({ env = process.env, fetch: fetcher = globalThis.fetch, now = Date.now,
  directory = env.LIRA_UPDATE_CACHE_DIR || path.join(os.tmpdir(), 'lira-update-cache'),
  baseUrl = BASE_URL, warn = console.warn } = {}) {
  const stateFile = path.join(directory, 'cache.json')
  let state = { lastCheckedAt: 0, lastSuccessfulAt: 0, release: null, previous: null }
  let loading, pending, timer
  let phase = 'idle'
  let lastFailure = null
  const headers = binary => {
    const value = { 'User-Agent': 'Lira-Update-Cache', Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json' }
    const token = env.GITHUB_RELEASES_TOKEN || env.GITHUB_TOKEN || env.GITHUB_REPORT_TOKEN
    if (token) value.Authorization = `Bearer ${token}`
    return value
  }
  const filename = asset => `${asset.id}-${asset.sha256}.bin`
  async function persist(next) {
    const temporary = `${stateFile}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(next))
      await fs.rename(temporary, stateFile)
    } finally { await fs.unlink(temporary).catch(() => {}) }
  }
  async function validCachedRelease(release) {
    if (!release || !VERSION.test(release.tag_name || '') || !Array.isArray(release.assets) || !release.assets.length || release.assets.length > 2) return null
    for (const asset of release.assets) {
      if (!validId(asset.id) || !/^[a-f0-9]{64}$/.test(asset.sha256 || '') || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ASSET_BYTES ||
          !/^Lira[\w .-]*\.(exe|apk)$/i.test(asset.name || '')) return null
      const file = path.join(directory, filename(asset))
      try {
        if ((await fs.stat(file)).size !== asset.size || await hashOf(file) !== asset.sha256) return null
      } catch { return null }
    }
    return release
  }
  async function load() {
    if (!loading) loading = (async () => {
      await fs.mkdir(directory, { recursive: true })
      try {
        const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'))
        const release = await validCachedRelease(saved.release)
        const previous = await validCachedRelease(saved.previous)
        state = { lastCheckedAt: Number.isFinite(saved.lastCheckedAt) ? saved.lastCheckedAt : 0,
          lastSuccessfulAt: Number.isFinite(saved.lastSuccessfulAt) ? saved.lastSuccessfulAt : 0,
          release: release || previous, previous: release ? previous : null }
        // A missing or corrupt cache needs rebuilding, even if today's check already ran.
        if (!state.release) state.lastCheckedAt = 0
      } catch (error) { if (error.code !== 'ENOENT') warn('[Lira Updates] Cache indisponível; será reconstruído.') }
    })()
    return loading
  }
  async function metadata() {
    const response = await fetcher(`${API}/releases/latest`, { headers: headers(false), redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw Object.assign(new Error('release unavailable'), { code: `GITHUB_HTTP_${response.status}` })
    const chunks = []; let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > 1024 * 1024) throw new Error('release too large')
      chunks.push(Buffer.from(chunk))
    }
    const release = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (release.draft || release.prerelease || !VERSION.test(release.tag_name || '')) throw new Error('invalid release')
    const assets = ['exe', 'apk'].map(extension => release.assets?.find(asset =>
      /^Lira[\w .-]*$/i.test(asset.name || '') && asset.name.toLowerCase().endsWith(`.${extension}`) && asset.state === 'uploaded')).filter(Boolean)
    if (!assets.length) throw new Error('no installers')
    for (const asset of assets) {
      if (!validId(asset.id) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ASSET_BYTES ||
          (asset.digest != null && !/^sha256:[a-f0-9]{64}$/.test(asset.digest))) throw new Error('invalid installer')
    }
    return { tag_name: release.tag_name, name: String(release.name || release.tag_name), body: String(release.body || ''),
      html_url: `https://github.com/C1ean-dev/Lira/releases/tag/${release.tag_name}`, assets }
  }
  async function cacheAsset(asset) {
    phase = asset.name.endsWith('.apk') ? 'android_installer' : 'windows_installer'
    const old = [state.release, state.previous].flatMap(release => release?.assets || []).find(item =>
      item.id === asset.id && item.size === asset.size && (!asset.digest || asset.digest === `sha256:${item.sha256}`))
    if (old) return { ...old, name: asset.name }
    let response = await fetcher(`${API}/releases/assets/${asset.id}`, { headers: headers(true), redirect: 'manual', signal: AbortSignal.timeout(180000) })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const redirect = new URL(response.headers.get('location'))
      await response.body?.cancel()
      if (redirect.protocol !== 'https:' || redirect.username || redirect.password ||
          !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(redirect.hostname)) throw new Error('invalid redirect')
      // Signed asset URLs must never receive the GitHub token.
      response = await fetcher(redirect.href, { redirect: 'error', signal: AbortSignal.timeout(180000) })
    }
    if (response.status !== 200 || !response.body) throw Object.assign(new Error('installer unavailable'), { code: `GITHUB_HTTP_${response.status}` })
    const temporary = path.join(directory, `${asset.id}-${randomUUID()}.tmp`)
    let bytes = 0
    const hash = createHash('sha256')
    const count = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length
      if (bytes > asset.size) { done(new Error('installer too large')); return }
      hash.update(chunk); done(null, chunk)
    } })
    try {
      await pipeline(Readable.fromWeb(response.body), count, createWriteStream(temporary, { flags: 'wx' }))
      const sha256 = hash.digest('hex')
      if (bytes !== asset.size || (asset.digest && asset.digest !== `sha256:${sha256}`)) throw new Error('installer verification failed')
      const cached = { id: asset.id, name: asset.name, size: bytes, sha256 }
      await fs.rename(temporary, path.join(directory, filename(cached)))
      return cached
    } finally { await fs.unlink(temporary).catch(() => {}) }
  }
  async function cleanup() {
    const keep = new Set([state.release, state.previous].flatMap(release => release?.assets || []).map(filename))
    for (const file of await fs.readdir(directory)) {
      if (/^\d+-[a-f0-9]{64}\.bin$/.test(file) && !keep.has(file)) await fs.unlink(path.join(directory, file)).catch(() => {})
    }
  }
  async function refresh() {
    await load()
    if (pending) return pending
    if (state.lastCheckedAt && now() - state.lastCheckedAt < UPDATE_INTERVAL_MS) return
    pending = (async () => {
      phase = 'cache_storage'
      state.lastCheckedAt = now()
      try {
        await persist(state)
        phase = 'release_metadata'
        const release = await metadata()
        const assets = []
        for (const asset of release.assets) assets.push(await cacheAsset(asset))
        const changed = JSON.stringify(assets) !== JSON.stringify(state.release?.assets)
        const next = { ...state, lastSuccessfulAt: now(), release: { ...release, assets },
          previous: changed ? state.release : state.previous }
        // Publish metadata only after all files are verified and ready to serve.
        phase = 'publish_cache'
        await persist(next)
        state = next
        lastFailure = null
      } catch (error) {
        const code = /^(GITHUB_HTTP_\d{3}|EACCES|EPERM|ENOSPC|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN)$/.test(error.code || '')
          ? error.code : /^(invalid release|no installers|invalid installer|invalid redirect|installer verification failed|installer too large|release too large)$/.test(error.message)
            ? error.message.replaceAll(' ', '_') : error.name === 'TimeoutError' ? 'upstream_timeout' : 'cache_refresh_failed'
        lastFailure = { stage: phase, code }
        warn(`[Lira Updates] Consulta diária falhou em ${phase} (${code}); a última atualização válida foi preservada.`)
      } finally {
        phase = 'idle'
        // Failed multi-file refreshes must not accumulate unpublished installers.
        await cleanup().catch(() => {})
      }
    })().finally(() => { pending = null })
    return pending
  }
  const router = express.Router()
  router.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    next()
  })
  router.options('*', (_req, res) => res.sendStatus(204))
  router.get('/latest', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      await load()
      void refresh().catch(() => warn('[Lira Updates] Não foi possível preparar o cache.'))
      if (!state.release) {
        const seconds = pending ? 30 : Math.max(30, Math.ceil((state.lastCheckedAt + UPDATE_INTERVAL_MS - now()) / 1000))
        res.setHeader('Retry-After', String(seconds))
        res.status(503).json({ error: 'update_cache_unavailable', status: pending ? 'preparing' : 'unavailable',
          stage: phase, last_checked_at: state.lastCheckedAt ? new Date(state.lastCheckedAt).toISOString() : null, failure: lastFailure })
        return
      }
      res.json({ ...state.release, checked_at: new Date(state.lastSuccessfulAt).toISOString(),
        stale: now() - state.lastSuccessfulAt >= UPDATE_INTERVAL_MS,
        assets: state.release.assets.map(asset => ({ id: asset.id, name: asset.name, size: asset.size,
          digest: `sha256:${asset.sha256}`, browser_download_url: `${baseUrl}/assets/${asset.id}` })) })
    } catch { res.status(503).json({ error: 'update_cache_unavailable' }) }
  })
  router.get('/assets/:assetId', async (req, res) => {
    try {
      await load()
      const asset = [state.release, state.previous].flatMap(release => release?.assets || []).find(item => String(item.id) === req.params.assetId)
      if (!asset) { res.sendStatus(404); return }
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable')
      res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader('ETag', `"${asset.sha256}"`)
      res.download(path.resolve(directory, filename(asset)), asset.name, error => {
        if (error && !res.headersSent) res.status(503).end()
      })
    } catch { if (!res.headersSent) res.sendStatus(503) }
  })
  return { router, refresh,
    start() {
      if (!timer) { timer = setInterval(() => { void refresh().catch(() => {}) }, 60000); timer.unref() }
      return refresh()
    },
    close() { clearInterval(timer); timer = null },
  }
}
