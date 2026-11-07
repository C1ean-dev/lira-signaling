import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REPO = 'C1ean-dev/lira-clean'
const API = `https://api.github.com/repos/${REPO}`
export const INSTALLER = 'Lira-Clean-Nativo-Windows-x64-Setup.exe'
const MAX_BYTES = 256 * 1024 * 1024
const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function releaseUpdate(release, baseUrl) {
  if (!release || release.draft || release.prerelease || !VERSION.test(release.tag_name || '')) return null
  const asset = release.assets?.find(asset => asset.name === INSTALLER && asset.state === 'uploaded')
  if (!asset || !Number.isSafeInteger(asset.id) || asset.id < 1 || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_BYTES ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) return null
  return {
    version: release.tag_name.replace(/^v/, ''),
    release_url: `https://github.com/${REPO}/releases/tag/${release.tag_name}`,
    installer: { url: `${baseUrl}/assets/${asset.id}`, size: asset.size, sha256: asset.digest.slice(7) },
  }
}

async function json(response) {
  if (!response.ok) throw new Error('upstream')
  let bytes = 0
  const chunks = []
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > 256 * 1024) throw new Error('limit')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createNativeUpdates({ env = process.env, fetch: fetcher = globalThis.fetch, now = Date.now,
  baseUrl = 'https://lira-signaling.onrender.com/updates/lira-clean' } = {}) {
  let cached
  let until = 0
  let pending
  const headers = (binary = false) => {
    const value = { 'User-Agent': 'Lira-Native-Updates', Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json' }
    const token = env.GITHUB_RELEASES_TOKEN || env.GITHUB_REPORT_TOKEN || env.GITHUB_TOKEN
    if (token) value.Authorization = `Bearer ${token}`
    return value
  }
  async function latest() {
    if (now() < until) return cached
    if (!pending) pending = (async () => {
      const releases = await json(await fetcher(`${API}/releases?per_page=100`, { headers: headers(), redirect: 'error', signal: AbortSignal.timeout(8000) }))
      if (!Array.isArray(releases)) throw new Error('response')
      cached = releases.map(release => releaseUpdate(release, baseUrl)).find(Boolean) || null
      until = now() + 60000
      return cached
    })().finally(() => { pending = null })
    return pending
  }
  return {
    async latest(req, res) {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const update = await latest()
        res.statusCode = update ? 200 : 204
        res.setHeader('Content-Type', 'application/json')
        res.end(update ? JSON.stringify(update) : undefined)
      } catch { res.statusCode = 503; res.end() }
    },
    async asset(req, res) {
      try {
        const update = await latest()
        if (!update || String(req.params?.assetId) !== update.installer.url.split('/').at(-1)) { res.statusCode = 404; res.end(); return }
        let response = await fetcher(`${API}/releases/assets/${req.params.assetId}`, { headers: headers(true), redirect: 'manual', signal: AbortSignal.timeout(120000) })
        if (response.status === 302) {
          const redirect = new URL(response.headers.get('location'))
          if (redirect.protocol !== 'https:' || redirect.username || redirect.password ||
              !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(redirect.hostname)) throw new Error('redirect')
          // A signed download URL must never receive the GitHub bot token.
          response = await fetcher(redirect.href, { redirect: 'error', signal: AbortSignal.timeout(120000) })
        }
        if (!response.ok) throw new Error('download')
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Disposition', `attachment; filename="${INSTALLER}"`)
        res.setHeader('Content-Length', String(update.installer.size))
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.setHeader('Cache-Control', 'private, max-age=0')
        let bytes = 0
        async function* bounded() {
          for await (const chunk of response.body) {
            bytes += chunk.length
            if (bytes > update.installer.size) throw new Error('size')
            yield chunk
          }
          if (bytes !== update.installer.size) throw new Error('incomplete')
        }
        await pipeline(Readable.from(bounded()), res)
      } catch {
        if (res.headersSent) res.destroy()
        else { res.statusCode = 503; res.end() }
      }
    },
  }
}
