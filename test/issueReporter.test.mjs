import test from 'node:test'
import assert from 'node:assert/strict'
import { createIssueReporterHandler } from '../issueReporter.js'

const env = { GITHUB_REPORT_TOKEN: 'secret-github-bot-token', GITHUB_REPO: 'C1ean-dev/Lira' }

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(body) {
      this.rawBody = body
      this.body = body ? JSON.parse(body) : null
    },
  }
}

test('creates issue successfully on GitHub and returns 201 with issueUrl', async () => {
  const calls = []
  const fetchMock = async (url, opts) => {
    calls.push({ url, opts })
    if (url.includes('/issues')) {
      return {
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/C1ean-dev/Lira/issues/999',
          number: 999,
        }),
      }
    }
    return { ok: false }
  }

  const handler = createIssueReporterHandler({ env, fetch: fetchMock })
  const req = {
    method: 'POST',
    ip: '127.0.0.1',
    body: {
      title: 'Problema no áudio',
      description: 'O som corta ao iniciar a sala',
      systemInfo: { appVersion: '1.1.117', os: 'win32' },
    },
  }
  const res = mockResponse()

  await handler(req, res)

  assert.equal(res.statusCode, 201)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.issueUrl, 'https://github.com/C1ean-dev/Lira/issues/999')
  assert.equal(res.body.issueNumber, 999)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.github.com/repos/C1ean-dev/Lira/issues')
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer secret-github-bot-token')
  const sentBody = JSON.parse(calls[0].opts.body)
  assert.equal(sentBody.title, 'Problema no áudio')
  assert.ok(sentBody.body.includes('O som corta ao iniciar a sala'))
  assert.ok(sentBody.body.includes('1.1.117'))
  assert.deepEqual(sentBody.labels, ['bug', 'needs-triage'])
})

test('creates Gist if rawFiles are provided', async () => {
  const calls = []
  const fetchMock = async (url, opts) => {
    calls.push({ url, opts })
    if (url.includes('/gists')) {
      return {
        ok: true,
        json: async () => ({
          html_url: 'https://gist.github.com/C1ean-dev/abcdef123456',
        }),
      }
    }
    if (url.includes('/issues')) {
      return {
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/C1ean-dev/Lira/issues/1000',
          number: 1000,
        }),
      }
    }
    return { ok: false }
  }

  const handler = createIssueReporterHandler({ env, fetch: fetchMock })
  const req = {
    method: 'POST',
    ip: '127.0.0.1',
    body: {
      title: 'Erro com logs',
      description: 'Logs completos anexados',
      rawFiles: [{ name: 'lira.log', content: '2026-11-03 ERROR' }],
    },
  }
  const res = mockResponse()

  await handler(req, res)

  assert.equal(res.statusCode, 201)
  assert.equal(res.body.gistUrl, 'https://gist.github.com/C1ean-dev/abcdef123456')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://api.github.com/gists')
  assert.equal(calls[1].url, 'https://api.github.com/repos/C1ean-dev/Lira/issues')
})

test('returns 503 if GITHUB_REPORT_TOKEN is not configured', async () => {
  const handler = createIssueReporterHandler({ env: {} })
  const req = {
    method: 'POST',
    ip: '127.0.0.1',
    body: { title: 'Teste', description: 'Teste desc' },
  }
  const res = mockResponse()
  await handler(req, res)

  assert.equal(res.statusCode, 503)
  assert.equal(res.body.ok, false)
  assert.ok(res.body.error.includes('not configured'))
})

test('validates minimum and maximum length for title and description', async () => {
  const handler = createIssueReporterHandler({ env })

  // Short title
  const res1 = mockResponse()
  await handler({ method: 'POST', ip: '1.1.1.1', body: { title: 'ab', description: 'desc valida' } }, res1)
  assert.equal(res1.statusCode, 400)

  // Short description
  const res2 = mockResponse()
  await handler({ method: 'POST', ip: '1.1.1.1', body: { title: 'titulo valido', description: '123' } }, res2)
  assert.equal(res2.statusCode, 400)
})

test('rate limits requests per IP after 5 submissions per hour', async () => {
  let currentTime = 1000000
  const fetchMock = async () => ({
    ok: true,
    json: async () => ({ html_url: 'https://github.com/C1ean-dev/Lira/issues/1', number: 1 }),
  })
  const handler = createIssueReporterHandler({ env, fetch: fetchMock, now: () => currentTime })
  const req = {
    method: 'POST',
    ip: '10.0.0.99',
    body: { title: 'Titulo spam', description: 'Descricao spam' },
  }

  for (let i = 0; i < 5; i++) {
    const res = mockResponse()
    await handler(req, res)
    assert.equal(res.statusCode, 201)
  }

  const res6 = mockResponse()
  await handler(req, res6)
  assert.equal(res6.statusCode, 429)
  assert.equal(res6.body.ok, false)
  assert.equal(res6.headers['Retry-After'], '3600')
  assert.match(res6.body.error, /hour/i)

  // Resets after 1 hour window
  currentTime += 60 * 60 * 1000 + 1
  const resAfterHour = mockResponse()
  await handler(req, resAfterHour)
  assert.equal(resAfterHour.statusCode, 201)
  assert.equal(resAfterHour.body.ok, true)
})

test('handles CORS preflight OPTIONS request with 204', async () => {
  const handler = createIssueReporterHandler({ env })
  const res = mockResponse()
  await handler({ method: 'OPTIONS' }, res)
  assert.equal(res.statusCode, 204)
  assert.equal(res.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS')
})
