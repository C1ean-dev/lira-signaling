import { createHash } from 'node:crypto'

const MAX_FILE = 2 * 1024 * 1024
const MAX_JSON = 10 * 1024 * 1024
const GIST_ID = /^[a-f0-9]{5,64}$/i
const SHA256 = /^[a-f0-9]{64}$/

export function attachmentManifest(rawFiles) {
  const file = rawFiles?.find(file => file?.name === 'anexos-manifesto.json')
  if (!file || typeof file.content !== 'string' || file.content.length > 32768) return []
  try {
    const items = JSON.parse(file.content)
    if (!Array.isArray(items) || items.length > 8) return []
    if (!items.every((item, index) => item && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 255 &&
      !/[\\/\x00-\x1f\x7f]/.test(item.name) && !['.', '..'].includes(item.name) &&
      Number.isSafeInteger(item.size) && item.size >= 0 && item.size <= MAX_FILE && SHA256.test(item.sha256) &&
      Array.isArray(item.parts) && item.parts.length <= 8 && item.parts.every((part, partIndex) =>
        part === `anexo-${String(index + 1).padStart(3, '0')}.parte-${String(partIndex + 1).padStart(3, '0')}.b64`))) return []
    return items
  } catch { return [] }
}

export function buildAttachmentLinks(gistUrl, rawFiles, baseUrl) {
  if (!baseUrl) return []
  try {
    const gist = new URL(gistUrl)
    const id = gist.pathname.split('/').filter(Boolean).at(-1)
    if (gist.protocol !== 'https:' || gist.hostname !== 'gist.github.com' || !GIST_ID.test(id)) return []
    return attachmentManifest(rawFiles).map((item, index) => ({
      name: item.name, size: item.size, sha256: item.sha256,
      url: `${baseUrl}/${id}/${index}`,
      image: /\.(png|jpe?g|gif|webp)$/i.test(item.name),
    }))
  } catch { return [] }
}

export function attachmentMarkdown(files) {
  if (!files.length) return ''
  const escape = name => name.replace(/[\\[\]()!<>`*_]/g, '\\$&')
  return '\n\n### Arquivos enviados\n\n' + files.map(file =>
    `[Baixar ${escape(file.name)}](${file.url}) (${file.size} bytes)\n` +
    (file.image ? `\n![${escape(file.name)}](${file.url})\n` : '')).join('\n')
}

async function readText(response, limit) {
  if (!response.ok) throw new Error('upstream')
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > limit) throw new Error('limit')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function gistFile(file, gistId, fetcher, limit = 500000) {
  if (!file) throw new Error('missing')
  if (!file.truncated && typeof file.content === 'string') {
    if (Buffer.byteLength(file.content) > limit) throw new Error('limit')
    return file.content
  }
  const url = new URL(file.raw_url)
  if (url.protocol !== 'https:' || url.hostname !== 'gist.githubusercontent.com' || url.username || url.password ||
      url.pathname.split('/')[2]?.toLowerCase() !== gistId.toLowerCase()) throw new Error('raw-url')
  // Never forward the bot credential to a raw-file host or follow redirects.
  return readText(await fetcher(url.href, { redirect: 'error', signal: AbortSignal.timeout(8000) }), limit)
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

export function createReportAttachmentHandler({ env = process.env, fetch: fetcher = globalThis.fetch } = {}) {
  let active = 0
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'no-store')
    const fail = status => { res.statusCode = status; res.end('Arquivo indisponível.') }
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); fail(405); return }
    const id = req.params?.gistId
    const position = req.params?.index
    if (!GIST_ID.test(id || '') || !/^[0-7]$/.test(position || '')) { fail(404); return }
    if (active >= 8) { fail(503); return }
    active++
    try {
      const token = env.GITHUB_REPORT_TOKEN || env.GITHUB_TOKEN
      const headers = { 'User-Agent': 'Lira-Signaling-Server', Accept: 'application/vnd.github+json' }
      if (token) headers.Authorization = `Bearer ${token}`
      const gist = JSON.parse(await readText(await fetcher(`https://api.github.com/gists/${id}`, {
        headers, redirect: 'error', signal: AbortSignal.timeout(8000),
      }), MAX_JSON))
      if (typeof gist.description !== 'string' || !gist.description.startsWith('Logs da Issue:')) throw new Error('not-a-report')
      const manifestText = await gistFile(gist.files?.['anexos-manifesto.json'], id, fetcher, 32768)
      const item = attachmentManifest([{ name: 'anexos-manifesto.json', content: manifestText }])[Number(position)]
      if (!item) throw new Error('missing')
      const parts = await Promise.all(item.parts.map(part => gistFile(gist.files?.[part], id, fetcher)))
      const encoded = parts.join('')
      if (encoded.length !== Math.ceil(item.size / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('encoding')
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.length !== item.size || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('hash')
      const type = imageType(bytes)
      const name = item.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      res.setHeader('Content-Type', type || 'application/octet-stream')
      res.setHeader('Content-Disposition', `${type ? 'inline' : 'attachment'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(item.name).replace(/'/g, '%27')}`)
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.setHeader('ETag', `"${item.sha256}"`)
      res.setHeader('Content-Length', String(bytes.length))
      res.statusCode = 200
      res.end(req.method === 'HEAD' ? undefined : bytes)
    } catch { fail(404) }
    finally { active-- }
  }
}
