const TTL_SECONDS = 86400
const WINDOW_MS = 60000

export function createTurnCredentialsHandler({ env = process.env, fetch: fetcher = globalThis.fetch, now = Date.now } = {}) {
  const clients = new Map()
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }
    const fail = (status, error) => { res.statusCode = status; res.end(JSON.stringify({ error })) }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET, OPTIONS'); fail(405, 'Method not allowed'); return }
    const key = env.CLOUDFLARE_TURN_KEY_ID
    const token = env.CLOUDFLARE_TURN_API_TOKEN
    if (!key || !token || !/^[a-zA-Z0-9_-]+$/.test(key)) { fail(503, 'TURN unavailable'); return }
    const time = now()
    for (const [ip, bucket] of clients) if (bucket.until <= time) clients.delete(ip)
    const ip = req.ip || req.socket?.remoteAddress || 'unknown'
    let bucket = clients.get(ip)
    if (!bucket) {
      if (clients.size >= 10000) { fail(429, 'Try again later'); return }
      bucket = { count: 0, until: time + WINDOW_MS }
      clients.set(ip, bucket)
    }
    if (++bucket.count > 10) { res.setHeader('Retry-After', '60'); fail(429, 'Try again later'); return }
    try {
      const response = await fetcher(`https://rtc.live.cloudflare.com/v1/turn/keys/${key}/credentials/generate-ice-servers`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_SECONDS }), signal: AbortSignal.timeout(4000),
      })
      if (!response.ok) throw new Error('Upstream unavailable')
      const data = await response.json()
      if (!Array.isArray(data.iceServers) || !data.iceServers.length) throw new Error('Invalid ICE servers')
      const iceServers = data.iceServers.map(server => {
        const urls = typeof server.urls === 'string' ? [server.urls] : server.urls
        if (!Array.isArray(urls) || !urls.length || !urls.every(url => typeof url === 'string' && /^(?:stun|turn)s?:[^\s/?#]+(?:\?transport=(?:udp|tcp))?$/.test(url))) throw new Error('Invalid ICE URLs')
        if (urls.some(url => /^turns?:/.test(url)) && (typeof server.username !== 'string' || !server.username.trim() || typeof server.credential !== 'string' || !server.credential.trim())) throw new Error('Invalid ICE credentials')
        return { urls: server.urls, ...(server.username ? { username: server.username, credential: server.credential } : {}) }
      })
      if (!iceServers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/.test(url)))) throw new Error('Missing relay')
      res.end(JSON.stringify({ iceServers, expiresAt: time + TTL_SECONDS * 1000 }))
    } catch {
      fail(502, 'TURN credentials temporarily unavailable')
    }
  }
}
