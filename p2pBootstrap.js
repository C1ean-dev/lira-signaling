import { createPublicKey, verify } from 'node:crypto'

const MAX_BYTES = 64 * 1024
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const base64url = /^[A-Za-z0-9_-]+$/

export function createP2pBootstrapHandler({ env = process.env, now = Date.now } = {}) {
  return (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    const fail = (status, error) => {
      res.setHeader('Cache-Control', 'no-store')
      res.statusCode = status
      res.end(JSON.stringify({ error }))
    }
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET, OPTIONS'); fail(405, 'Method not allowed'); return }
    const raw = env.LIRA_P2P_BOOTSTRAP_MANIFEST
    const publicKey = env.LIRA_P2P_CATALOG_KEY
    if (!raw || !publicKey) { fail(503, 'P2P bootstrap unavailable'); return }
    try {
      if (Buffer.byteLength(raw) > MAX_BYTES || !base64url.test(publicKey)) throw new Error()
      const key = Buffer.from(publicKey, 'base64url')
      const envelope = JSON.parse(raw)
      if (key.length !== 32 || !envelope || Object.keys(envelope).length !== 2 ||
          typeof envelope.payload !== 'string' || !base64url.test(envelope.payload) ||
          typeof envelope.signature !== 'string' || !base64url.test(envelope.signature)) throw new Error()
      const data = Buffer.from(envelope.payload, 'base64url')
      const signature = Buffer.from(envelope.signature, 'base64url')
      const spki = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, key]), format: 'der', type: 'spki' })
      if (signature.length !== 64 || !verify(null, data, spki, signature)) throw new Error()
      const catalog = JSON.parse(data.toString('utf8'))
      const current = Math.floor(now() / 1000)
      if (catalog.version !== 1 || !Number.isSafeInteger(catalog.revision) || catalog.revision < 1 ||
          !Number.isSafeInteger(catalog.expires) || catalog.expires <= current ||
          catalog.expires > current + 30 * 86400 || !Array.isArray(catalog.nodes) || catalog.nodes.length > 32) throw new Error()
      for (const node of catalog.nodes) {
        if (!node || typeof node.peer_id !== 'string' || node.peer_id.length > 128 ||
            !Array.isArray(node.addresses) || !node.addresses.length || node.addresses.length > 8 ||
            !node.addresses.every(address => typeof address === 'string' && address.length <= 1024 && address.endsWith('/p2p/' + node.peer_id)) ||
            !Array.isArray(node.roles) || node.roles.length > 3 || !node.roles.includes('bootstrap') ||
            !node.roles.includes('relay') || node.roles.some(role => !['bootstrap', 'relay', 'media'].includes(role))) throw new Error()
      }
      res.setHeader('Cache-Control', 'public, max-age=' + Math.min(300, catalog.expires - current))
      res.statusCode = 200
      res.end(JSON.stringify(envelope))
    } catch {
      fail(503, 'P2P bootstrap unavailable')
    }
  }
}
