import { launchNativeInvite } from './launch.js'

const MAX_LENGTH = 30000
const ROOM = /^[A-Z0-9][A-Z0-9_-]{0,99}$/
const invalid = () => new Error('O convite está incompleto ou inválido. Peça um novo link a quem convidou você.')
const expired = () => new Error('Este convite expirou. Peça um novo link a quem convidou você.')

function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalid()
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))))
  } catch { throw invalid() }
}

function directOffer(offer, room, now) {
  if (offer?.version !== 1 || offer.kind !== 'offer' || offer.room !== room
    || typeof offer.session !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(offer.session) || offer.host !== `lira-${room}-host`
    || typeof offer.guest !== 'string' || !offer.guest.startsWith(`lira-${room}-peer-`)
    || !/^[a-zA-Z0-9_-]{1,160}$/.test(offer.guest) || !Number.isFinite(offer.expiresAt)
    || offer.expiresAt > now + 15 * 60000 || offer.description?.type !== 'offer'
    || typeof offer.description.sdp !== 'string' || !offer.description.sdp.startsWith('v=0')
    || offer.description.sdp.length > 100000) throw invalid()
  return offer.expiresAt > now
}

/** Read only the fragment; a normal page request never carries the invitation. */
export function readInvitation(hash, now = Date.now()) {
  if (hash.length > MAX_LENGTH) throw invalid()
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const invite = params.get('invite')
  if (!invite || params.getAll('invite').length !== 1 || [...params.keys()].some(key => key !== 'invite')) throw invalid()
  if (`lira://join?invite=${encodeURIComponent(invite)}`.length > MAX_LENGTH) throw invalid()
  if (ROOM.test(invite)) return invite
  const match = /^(LIRA-ALL:|LIRA-LAN:|LIRA-DIRECT:)([A-Za-z0-9_-]+)$/.exec(invite)
  if (!match) throw invalid()
  const data = decode(match[2])
  if (typeof data?.room !== 'string' || !ROOM.test(data.room)) throw invalid()
  if (match[1] === 'LIRA-DIRECT:') {
    if (!directOffer(data, data.room, now)) throw expired()
  } else if (match[1] === 'LIRA-LAN:') {
    let validHost = typeof data.host === 'string' && /^[a-zA-Z0-9.-]{1,253}$/.test(data.host)
    if (typeof data.host === 'string' && /^\[[a-fA-F0-9:]+\]$/.test(data.host)) {
      try { validHost = new URL(`http://${data.host}/`).hostname.startsWith('[') } catch {}
    }
    if (!validHost || !Number.isInteger(data.port) || data.port < 1 || data.port > 65535) throw invalid()
  } else {
    if (data.version !== 1 || (data.signaling !== undefined && !['render', 'public'].includes(data.signaling))) throw invalid()
    if (data.ipv6 !== undefined && (!Array.isArray(data.ipv6?.addresses) || !data.ipv6.addresses.length
      || data.ipv6.addresses.length > 4 || !data.ipv6.addresses.every(host => {
        if (typeof host !== 'string' || !/^\[[23][a-f0-9]{3}:/i.test(host)) return false
        try { return new URL(`http://${host}/`).hostname.startsWith('[') } catch { return false }
      }) || !Number.isInteger(data.ipv6.port) || data.ipv6.port < 1 || data.ipv6.port > 65535)) throw invalid()
    const directUsable = data.direct !== undefined && directOffer(data.direct, data.room, now)
    if (!data.signaling && !data.ipv6 && !directUsable) throw expired()
  }
  return invite
}

export async function nativeInviteLink(invite) {
  const raw = `lira://join?invite=${encodeURIComponent(invite)}`
  if (raw.length <= 2081) return raw
  const stream = new Blob([invite]).stream().pipeThrough(new CompressionStream('gzip'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const packed = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const link = `lira://join?inviteGzip=${packed}`
  if (link.length > 2081) throw new Error('Este convite é grande demais para abrir pelo navegador. Use Copiar convite e cole no Lira.')
  return link
}

if (typeof document !== 'undefined') {
  const open = document.getElementById('open-lira')
  const copy = document.getElementById('copy-invite')
  const status = document.getElementById('status')
  let invite = ''
  let generation = 0
  let attemptedHash = ''
  const launch = () => {
    try {
      readInvitation(window.location.hash)
      status.textContent = 'Tentando abrir o Lira. Confirme a abertura se o navegador solicitar. Se não abrir, instale ou atualize o aplicativo e tente novamente.'
      launchNativeInvite(open.href)
    } catch (error) { status.textContent = error.message }
  }
  const load = async () => {
    const current = ++generation
    open.hidden = true
    copy.hidden = true
    open.removeAttribute('href')
    document.body.classList.remove('error')
    try {
      invite = readInvitation(window.location.hash)
      copy.hidden = false
      const href = await nativeInviteLink(invite)
      if (current !== generation) return
      open.href = href
      open.hidden = false
      document.getElementById('title').textContent = 'Seu espaço está a um clique.'
      document.getElementById('description').textContent = 'Você recebeu um convite para o Lira. Abra o aplicativo para entrar no espaço.'
      status.textContent = 'Se o navegador pedir uma confirmação, escolha Abrir Lira.'
      if (attemptedHash !== window.location.hash) {
        attemptedHash = window.location.hash
        launch()
      }
    } catch (error) {
      if (current !== generation) return
      invite = ''
      document.body.classList.add('error')
      document.getElementById('title').textContent = 'Vamos conferir seu convite.'
      document.getElementById('description').textContent = 'Não foi possível preparar a entrada no espaço.'
      status.textContent = error.message
    }
  }
  open.addEventListener('click', event => {
    event.preventDefault()
    try {
      // Recheck expiration if installation took longer than the direct offer's lifetime.
      invite = readInvitation(window.location.hash)
      launch()
    } catch { void load() }
  })
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(readInvitation(window.location.hash))
      status.textContent = 'Convite copiado. No Lira, cole em Conectar → Código da sala.'
    } catch { status.textContent = 'Não foi possível copiar. Tente Abrir no Lira ou peça um novo convite.' }
  })
  window.addEventListener('hashchange', load)
  load()
}
