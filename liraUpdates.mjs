import express from 'express'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
const REPO = 'C1ean-dev/Lira'
const API = `https://api.github.com/repos/${REPO}`
const VERSION = /^v?\d+\.\d+\.\d+$/
const ASSET_NAME = /^Lira[\w .-]*\.(exe|apk)$/i
const DIGEST = /^sha256:[a-f0-9]{64}$/
const MAX_ASSET_BYTES = 512 * 1024 * 1024
const BASE_URL = 'https://lira-signaling.onrender.com/updates/lira'
const validId = value => Number.isSafeInteger(value) && value > 0
const isNewerVersion = (latest, current) => {
  const parts = value => value.replace(/^v/i, '').split('.').map(BigInt)
  const left = parts(latest), right = parts(current)
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] > right[i]
  }
  return false
}
const releaseDownloadUrl = (tagName, name) =>
  `https://github.com/${REPO}/releases/download/${encodeURIComponent(tagName)}/${encodeURIComponent(name)}`

export function createLiraUpdates({ env = process.env, fetch: fetcher = globalThis.fetch, now = Date.now,
  directory = env.LIRA_UPDATE_CACHE_DIR || path.join(os.tmpdir(), 'lira-update-cache'),
  baseUrl = env.LIRA_UPDATES_BASE_URL || (env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/updates/lira` : BASE_URL),
  warn = console.warn } = {}) {
  const stateFile = path.join(directory, 'cache.json')
  let state = { lastCheckedAt: 0, lastSuccessfulAt: 0, release: null, previous: null }
  let loading, pending, timer
  let phase = 'idle'
  let lastFailure = null
  const headers = () => {
    const value = { 'User-Agent': 'Lira-Update-Cache', Accept: 'application/vnd.github+json' }
    const token = env.GITHUB_RELEASES_TOKEN || env.GITHUB_TOKEN || env.GITHUB_REPORT_TOKEN
    if (token) value.Authorization = `Bearer ${token}`
    return value
  }
  async function persist(next) {
    const temporary = `${stateFile}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(next))
      await fs.rename(temporary, stateFile)
    } finally { await fs.unlink(temporary).catch(() => {}) }
  }
  function normalizeAsset(asset) {
    if (!asset || !validId(asset.id) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ASSET_BYTES ||
        !ASSET_NAME.test(asset.name || '')) return null
    const digest = asset.digest ?? (typeof asset.sha256 === 'string' && /^[a-f0-9]{64}$/.test(asset.sha256) ? `sha256:${asset.sha256}` : null)
    if (digest != null && !DIGEST.test(digest)) return null
    return { id: asset.id, name: asset.name, size: asset.size, ...(digest ? { digest } : {}) }
  }
  function validCachedRelease(release) {
    if (!release || !VERSION.test(release.tag_name || '') || !Array.isArray(release.assets) || !release.assets.length || release.assets.length > 2) return null
    const assets = release.assets.map(normalizeAsset)
    if (assets.some(asset => !asset)) return null
    return {
      tag_name: release.tag_name,
      name: String(release.name || release.tag_name),
      body: String(release.body || ''),
      html_url: `https://github.com/${REPO}/releases/tag/${release.tag_name}`,
      assets,
    }
  }
  async function cleanupLegacyBinaries() {
    try {
      for (const file of await fs.readdir(directory)) {
        if (/^\d+-[a-f0-9]{64}\.bin$/.test(file)) await fs.unlink(path.join(directory, file)).catch(() => {})
      }
    } catch { /* Ignore cleanup errors on ephemeral storage. */ }
  }
  async function load() {
    if (!loading) loading = (async () => {
      await fs.mkdir(directory, { recursive: true })
      await cleanupLegacyBinaries()
      try {
        const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'))
        const release = validCachedRelease(saved.release)
        const previous = validCachedRelease(saved.previous)
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
    const response = await fetcher(`${API}/releases/latest`, { headers: headers(), redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw Object.assign(new Error('release unavailable'), { code: `GITHUB_HTTP_${response.status}` })
    const chunks = []; let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > 1024 * 1024) throw new Error('release too large')
      chunks.push(Buffer.from(chunk))
    }
    const release = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (release.draft || release.prerelease || !VERSION.test(release.tag_name || '')) throw new Error('invalid release')
    const rawAssets = ['exe', 'apk'].map(extension => release.assets?.find(asset =>
      /^Lira[\w .-]*$/i.test(asset.name || '') && asset.name.toLowerCase().endsWith(`.${extension}`) && asset.state === 'uploaded')).filter(Boolean)
    if (!rawAssets.length) throw new Error('no installers')
    const assets = rawAssets.map(normalizeAsset)
    if (assets.some(asset => !asset)) throw new Error('invalid installer')
    return { tag_name: release.tag_name, name: String(release.name || release.tag_name), body: String(release.body || ''),
      html_url: `https://github.com/${REPO}/releases/tag/${release.tag_name}`, assets }
  }
  async function refresh({ force = false, tagName } = {}) {
    await load()
    if (pending) return pending
    if (!force && state.lastCheckedAt && now() - state.lastCheckedAt < UPDATE_INTERVAL_MS) return
    pending = (async () => {
      phase = 'cache_storage'
      state.lastCheckedAt = now()
      try {
        await persist(state)
        phase = 'release_metadata'
        const release = await metadata()
        if (tagName && release.tag_name !== tagName) throw new Error('invalid release')
        if (tagName && (!release.assets.some(asset => asset.name.toLowerCase().endsWith('.exe')) ||
            !release.assets.some(asset => asset.name.toLowerCase().endsWith('.apk')))) throw new Error('no installers')
        let next = { ...state, lastSuccessfulAt: now() }
        // App checks keep equal or older versions untouched. The authenticated
        // publisher may finish a release cached before its second installer was uploaded.
        const newer = !state.release || isNewerVersion(release.tag_name, state.release.tag_name)
        const completePublication = tagName && state.release?.tag_name === tagName && state.release.assets.length < release.assets.length
        if (newer || completePublication) {
          next = { ...next, release, previous: newer ? state.release : state.previous }
        }
        phase = 'publish_cache'
        await persist(next)
        state = next
        lastFailure = null
      } catch (error) {
        const code = /^(GITHUB_HTTP_\d{3}|EACCES|EPERM|ENOSPC|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN)$/.test(error.code || '')
          ? error.code : /^(invalid release|no installers|invalid installer|release too large)$/.test(error.message)
            ? error.message.replaceAll(' ', '_') : error.name === 'TimeoutError' ? 'upstream_timeout' : 'cache_refresh_failed'
        lastFailure = { stage: phase, code }
        warn(`[Lira Updates] Consulta falhou em ${phase} (${code}); a última atualização válida foi preservada.`)
      } finally {
        phase = 'idle'
      }
    })().finally(() => { pending = null })
    return pending
  }
  const findAsset = assetId => {
    for (const release of [state.release, state.previous]) {
      const asset = release?.assets?.find(item => String(item.id) === assetId)
      if (asset) return { release, asset }
    }
    return null
  }
  const router = express.Router()
  router.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    next()
  })
  router.options('*', (_req, res) => res.sendStatus(204))
  router.post('/refresh', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    const token = env.LIRA_UPDATE_PUBLISH_TOKEN
    if (!token?.trim()) { res.status(503).json({ error: 'publication_not_configured' }); return }
    const hash = value => createHash('sha256').update(value).digest()
    if (!timingSafeEqual(hash(req.get('authorization') || ''), hash(`Bearer ${token}`))) {
      res.status(401).json({ error: 'unauthorized' }); return
    }
    next()
  }, express.json({ limit: '1kb' }), async (req, res) => {
    const tagName = req.body?.tag_name
    if (typeof tagName !== 'string' || !VERSION.test(tagName)) { res.status(400).json({ error: 'invalid_tag' }); return }
    try {
      await load()
      if (pending) await pending
      const ready = () => state.release?.tag_name === tagName && state.release.assets.length === 2
      if (!ready()) await refresh({ force: true, tagName })
      if (!ready()) { res.status(502).json({ error: 'publication_not_ready' }); return }
      res.json({ status: 'ready', tag_name: tagName })
    } catch { res.status(502).json({ error: 'publication_failed' }) }
  })
  router.get('/latest', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      await load()
      await refresh({ force: true })
      if (!state.release) {
        res.setHeader('Retry-After', '30')
        res.status(503).json({ error: 'update_cache_unavailable', status: pending ? 'preparing' : 'unavailable',
          stage: phase, last_checked_at: state.lastCheckedAt ? new Date(state.lastCheckedAt).toISOString() : null, failure: lastFailure })
        return
      }
      res.json({ ...state.release, checked_at: new Date(state.lastSuccessfulAt).toISOString(),
        stale: lastFailure !== null || now() - state.lastSuccessfulAt >= UPDATE_INTERVAL_MS,
        assets: state.release.assets.map(asset => ({ id: asset.id, name: asset.name, size: asset.size,
          ...(asset.digest ? { digest: asset.digest } : {}),
          browser_download_url: `${baseUrl}/assets/${asset.id}` })) })
    } catch { res.status(503).json({ error: 'update_cache_unavailable' }) }
  })
  router.get('/assets/:assetId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    try {
      await load()
      if (!state.release) await refresh({ force: true })
      else if (!findAsset(req.params.assetId) && pending) await pending
      const match = findAsset(req.params.assetId)
      if (!match) { res.sendStatus(404); return }
      // Redirect clients directly to the official GitHub Release CDN so installer
      // binaries never consume this server's outbound bandwidth.
      res.setHeader('Location', releaseDownloadUrl(match.release.tag_name, match.asset.name))
      res.status(302).end()
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
