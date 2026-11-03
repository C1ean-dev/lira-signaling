const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hora (limite de 5 chamadas por hora)
const MAX_REQUESTS_PER_WINDOW = 5

export function createIssueReporterHandler({
  env = process.env,
  fetch: fetcher = globalThis.fetch,
  now = Date.now,
  rateLimitWindowMs = RATE_LIMIT_WINDOW_MS,
  maxRequestsPerWindow = MAX_REQUESTS_PER_WINDOW,
} = {}) {
  const clients = new Map()

  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    const fail = (status, error) => {
      res.statusCode = status
      res.end(JSON.stringify({ ok: false, error }))
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS')
      fail(405, 'Method not allowed')
      return
    }

    const token = env.GITHUB_REPORT_TOKEN || env.GITHUB_TOKEN
    const targetRepo = env.GITHUB_REPO || 'C1ean-dev/Lira'

    if (!token) {
      fail(503, 'Issue reporting service is not configured on backend')
      return
    }

    // Limitação de taxa por IP
    const time = now()
    for (const [ip, bucket] of clients) {
      if (bucket.until <= time) clients.delete(ip)
    }

    const ip = req.ip || req.socket?.remoteAddress || 'unknown'
    let bucket = clients.get(ip)
    if (!bucket) {
      if (clients.size >= 10000) {
        fail(429, 'Too many requests, try again later')
        return
      }
      bucket = { count: 0, until: time + rateLimitWindowMs }
      clients.set(ip, bucket)
    }

    if (++bucket.count > maxRequestsPerWindow) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.until - time) / 1000))
      res.setHeader('Retry-After', String(retryAfterSeconds))
      fail(429, 'Too many reports from this client. Rate limit is 5 reports per hour.')
      return
    }

    // Validação do corpo da requisição
    const payload = req.body || {}
    const title = typeof payload.title === 'string' ? payload.title.trim() : ''
    const description = typeof payload.description === 'string' ? payload.description.trim() : ''

    if (!title || title.length < 3 || title.length > 250) {
      fail(400, 'Title must be between 3 and 250 characters')
      return
    }

    if (!description || description.length < 5 || description.length > 50000) {
      fail(400, 'Description must be between 5 and 50000 characters')
      return
    }

    try {
      // 1. Criação opcional de Gist com logs brutos
      let gistUrl = typeof payload.gistUrl === 'string' ? payload.gistUrl : null
      const rawFiles = Array.isArray(payload.rawFiles) ? payload.rawFiles : []
      if (!gistUrl && rawFiles.length > 0) {
        const gistFiles = {}
        for (const file of rawFiles) {
          if (file && typeof file.name === 'string' && typeof file.content === 'string') {
            const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
            gistFiles[cleanName] = { content: file.content.slice(0, 500000) }
          }
        }

        if (Object.keys(gistFiles).length > 0) {
          try {
            const gistRes = await fetcher('https://api.github.com/gists', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'User-Agent': 'Lira-Signaling-Server',
                'Content-Type': 'application/json',
                Accept: 'application/vnd.github+json',
              },
              body: JSON.stringify({
                description: `Logs da Issue: ${title.slice(0, 80)}`,
                public: false,
                files: gistFiles,
              }),
              signal: AbortSignal.timeout(6000),
            })
            if (gistRes.ok) {
              const gistData = await gistRes.json()
              gistUrl = gistData.html_url || null
            }
          } catch (e) {
            console.warn('[issueReporter] Gist creation failed (continuing without Gist):', e?.message || e)
          }
        }
      }

      // 2. Construção do corpo da Issue em Markdown
      let body = typeof payload.body === 'string' ? payload.body : null
      if (!body) {
        const parts = [
          '### Descrição do problema',
          description,
          '',
        ]

        if (payload.systemInfo && typeof payload.systemInfo === 'object') {
          parts.push('### Informações do Sistema')
          const sys = payload.systemInfo
          if (sys.appVersion) parts.push(`- **Versão do App**: ${sys.appVersion}`)
          if (sys.os) parts.push(`- **SO**: ${sys.os}`)
          if (sys.electron) parts.push(`- **Electron**: ${sys.electron}`)
          if (sys.chrome) parts.push(`- **Chrome**: ${sys.chrome}`)
          if (sys.node) parts.push(`- **Node**: ${sys.node}`)
          if (sys.timestamp) parts.push(`- **Data/Hora**: ${sys.timestamp}`)
          parts.push('')
        }

        if (gistUrl) {
          parts.push('### 📎 Anexo dos Logs de Diagnóstico')
          parts.push('> [!IMPORTANT]')
          parts.push(`> 🔗 **[Clique aqui para abrir os arquivos de log anexados no GitHub Gist](${gistUrl})**`)
          parts.push('')
        }

        if (payload.logSummaries && typeof payload.logSummaries === 'object') {
          for (const [name, content] of Object.entries(payload.logSummaries)) {
            if (typeof content === 'string' && content.trim()) {
              parts.push(`<details open>\n<summary>📋 ${name}</summary>\n\n\`\`\`text\n${content}\n\`\`\`\n</details>\n`)
            }
          }
        }

        parts.push('\n---\n*Issue enviada diretamente pelo aplicativo Lira.*')
        body = parts.join('\n')
      }

      // 3. Criação da Issue no GitHub
      const issueRes = await fetcher(`https://api.github.com/repos/${targetRepo}/issues`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Lira-Signaling-Server',
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
        },
        body: JSON.stringify({
          title,
          body,
          labels: ['bug', 'needs-triage'],
        }),
        signal: AbortSignal.timeout(8000),
      })

      if (!issueRes.ok) {
        const errText = await issueRes.text().catch(() => '')
        console.error(`[issueReporter] Upstream GitHub error ${issueRes.status}:`, errText)
        fail(502, 'Failed to create issue on GitHub')
        return
      }

      const issueData = await issueRes.json()
      res.statusCode = 201
      res.end(
        JSON.stringify({
          ok: true,
          issueUrl: issueData.html_url,
          issueNumber: issueData.number,
          gistUrl: gistUrl || undefined,
        })
      )
    } catch (err) {
      console.error('[issueReporter] Unexpected error:', err?.message || err)
      fail(502, 'Service temporarily unavailable')
    }
  }
}
