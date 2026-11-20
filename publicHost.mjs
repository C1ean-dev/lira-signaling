export const DEFAULT_PUBLIC_ORIGIN = 'https://lira-signaling.onrender.com'

export function publicHostname(env = process.env) {
  if (env.PUBLIC_BASE_URL) {
    try { return new URL(env.PUBLIC_BASE_URL).hostname } catch {}
  }
  return env.RENDER_EXTERNAL_HOSTNAME || env.KOYEB_PUBLIC_DOMAIN || ''
}

export function publicBaseUrl(env = process.env) {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/+$/, '')
  const host = env.RENDER_EXTERNAL_HOSTNAME || env.KOYEB_PUBLIC_DOMAIN
  return host ? `https://${host}` : DEFAULT_PUBLIC_ORIGIN
}
