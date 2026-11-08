import { createPublicKey, verify } from 'node:crypto'
import { isIP } from 'node:net'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const CATALOG_PATH = '/p2p/catalog/v1'
const DEFAULT_URL = 'https://lira-signaling.onrender.com' + CATALOG_PATH
const MAX_NODES = 128
const MAX_SOURCES = 8

function publicIP(host) {
  if (isIP(host) === 4) {
    const [a,b] = host.split('.').map(Number)
    return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0,168].includes(b)) && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18,19,51].includes(b)) && !(a === 203 && b === 0)
  }
  return isIP(host) === 6 && /^[23]/i.test(host) && !/^2001:db8:/i.test(host)
}
function publicHost(host) {
  if (isIP(host)) return publicIP(host)
  return host.includes('.') && /^[a-z0-9.-]+$/i.test(host) && !host.endsWith('.') && !/(^|\.)(localhost|local|internal|test|invalid)$/i.test(host)
}
function sourceURL(value) {
  try {
    const url = new URL(value)
    if (value.length > 512 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !publicHost(url.hostname.replace(/^\[|\]$/g,''))) return null
    return url.href
  } catch { return null }
}
function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'))
  let output = ''
  while (n) { output = alphabet[Number(n % 58n)] + output; n /= 58n }
  for (const byte of bytes) { if (byte) break; output = '1' + output }
  return output
}
function validAddress(address, peer, local) {
  if (typeof address !== 'string' || address.length > 1024) return false
  const parts = address.split('/').slice(1)
  if (parts.splice(-2,2).join('/') !== 'p2p/' + peer) return false
  const [family,host,transport,port,...tail] = parts
  const loopback = host === '127.0.0.1' || host === '::1'
  if (!['ip4','ip6','dns','dns4','dns6'].includes(family) || !(local && loopback) && !(family.startsWith('dns') ? publicHost(host) : publicIP(host))) return false
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return false
  if (transport === 'udp') return tail.join('/') === 'quic-v1'
  if (transport !== 'tcp') return false
  if (!tail.length) return true
  if (tail[0] === 'tls') tail.shift()
  else if (!['wss','x-parity-wss'].includes(tail[0]) && !(local && loopback)) return false
  return ['ws','wss','x-parity-ws','x-parity-wss'].includes(tail[0]) && tail.length <= 2 && (!tail[1] || tail[1].length <= 256 && decodeURIComponent(tail[1]).startsWith('/') && !/[\r\n?#]/.test(decodeURIComponent(tail[1])))
}

export function verifyAdvertisement(record, now = Math.floor(Date.now()/1000), local = false) {
  try {
    if (!record || Object.keys(record).some(key => !['payload','signature'].includes(key)) || typeof record.payload !== 'string' || typeof record.signature !== 'string' || record.payload.length > 5500 || record.signature.length > 100 || !/^[A-Za-z0-9_-]+$/.test(record.payload) || !/^[A-Za-z0-9_-]+$/.test(record.signature)) return null
    const payload = Buffer.from(record.payload,'base64url')
    if (payload.length > 4096) return null
    const node = JSON.parse(payload)
    const fields = ['version','public_key','peer_id','issued','expires','addresses','relay']
    if (Object.keys(node).some(key => !fields.includes(key)) || node.version !== 1 || typeof node.relay !== 'boolean' || !Array.isArray(node.public_key) || node.public_key.length !== 36 || !node.public_key.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) || !Number.isSafeInteger(node.issued) || !Number.isSafeInteger(node.expires) || node.issued > now+60 || node.expires <= now || node.expires > node.issued+600 || !Array.isArray(node.addresses) || !node.addresses.length || node.addresses.length > 8) return null
    const protobuf = Buffer.from(node.public_key)
    if (!protobuf.subarray(0,4).equals(Buffer.from([8,1,18,32]))) return null
    const peer = base58(Buffer.concat([Buffer.from([0,36]),protobuf]))
    if (node.peer_id !== peer || !node.addresses.every(address => validAddress(address,peer,local))) return null
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),protobuf.subarray(4)]),format:'der',type:'spki' })
    return verify(null,payload,key,Buffer.from(record.signature,'base64url')) ? node : null
  } catch { return null }
}

export function createP2PCatalog({ env = process.env, now = () => Math.floor(Date.now()/1000), allowLocal = false } = {}) {
  const records = new Map()
  const ownURL=env.LIRA_P2P_CATALOG_URL || (env.RENDER_EXTERNAL_HOSTNAME ? `https://${env.RENDER_EXTERNAL_HOSTNAME}${CATALOG_PATH}` : DEFAULT_URL)
  const sources = new Set([sourceURL(ownURL),...(env.LIRA_P2P_FEDERATE_RENDER==='false'?[]:[DEFAULT_URL])].filter(Boolean))
  const rates = new Map()
  const file = env.LIRA_P2P_CATALOG_FILE
  const prune = () => { for (const [peer,record] of records) if (!verifyAdvertisement(record,now(),allowLocal)) records.delete(peer) }
  const merge = body => {
    for (const record of body.nodes) {
      const node = verifyAdvertisement(record,now(),allowLocal)
      if (!node) continue
      const old = records.get(node.peer_id)
      const previous = old && verifyAdvertisement(old,now(),allowLocal)
      if ((!previous || node.issued >= previous.issued) && (old || records.size < MAX_NODES)) records.set(node.peer_id,{ payload:record.payload,signature:record.signature })
    }
    for (const candidate of body.sources) { const url = typeof candidate === 'string' && sourceURL(candidate); if (url && sources.size < MAX_SOURCES && !(env.LIRA_P2P_FEDERATE_RENDER==='false' && ownURL!==DEFAULT_URL && url===DEFAULT_URL)) sources.add(url) }
  }
  try { if (file) { const text=readFileSync(file,'utf8'); if (text.length <= 1024*1024) { const body=JSON.parse(text); if (Array.isArray(body.nodes) && body.nodes.length<=MAX_NODES && Array.isArray(body.sources) && body.sources.length<=MAX_SOURCES) merge(body) } } } catch { /* Clients repopulate an unavailable or expired cache. */ }
  const document = () => ({ version:1,nodes:[...records.values()],sources:[...sources] })
  let persistence = file ? 'configured' : 'memory'
  const save = () => {
    if (!file) return
    try { mkdirSync(dirname(file),{recursive:true}); writeFileSync(file+'.tmp',JSON.stringify(document()),{mode:0o600}); renameSync(file+'.tmp',file); persistence='disk' } catch { persistence='unavailable' }
  }
  return function catalog(req,res) {
    prune()
    res.setHeader('Content-Type','application/json; charset=utf-8')
    res.setHeader('Cache-Control','no-store')
    res.setHeader('X-Lira-Catalog-Storage',persistence)
    const send = (status,value) => { res.statusCode=status; res.end(JSON.stringify(value)) }
    if (req.method === 'GET') return send(200,document())
    if (req.method !== 'POST') { res.setHeader('Allow','GET, POST'); return send(405,{error:'method-not-allowed'}) }
    const address=req.ip || req.socket?.remoteAddress || 'unknown'
    const epoch=Math.floor(now()/60)
    for (const [key,value] of rates) if (value.epoch!==epoch) rates.delete(key)
    const bucket=rates.get(address) || {epoch,count:0}
    if ((!rates.has(address) && rates.size>=4096) || ++bucket.count>120) {res.setHeader('Retry-After','60');return send(429,{error:'rate-limited'})}
    rates.set(address,bucket)
    const body=req.body
    if (!body || body.version!==1 || Object.keys(body).some(key=>!['version','nodes','sources'].includes(key)) || !Array.isArray(body.nodes) || body.nodes.length>16 || !Array.isArray(body.sources) || body.sources.length>MAX_SOURCES) return send(400,{error:'invalid-catalog'})
    merge(body);save();return send(200,document())
  }
}
