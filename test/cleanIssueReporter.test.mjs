import test from 'node:test'
import assert from 'node:assert/strict'
import { createIssueReporterHandler } from '../issueReporter.js'

test('the native route pins lira-clean even when legacy env and payload request Lira', async () => {
  const calls = []
  const handler = createIssueReporterHandler({
    env: { GITHUB_REPORT_TOKEN: 'test-token', GITHUB_REPO: 'C1ean-dev/Lira' },
    targetRepository: 'C1ean-dev/lira-clean',
    fetch: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, json: async () => ({ html_url: url.endsWith('/gists') ? 'https://gist.github.com/test/123' : 'https://github.com/C1ean-dev/lira-clean/issues/1', number: 1 }) }
    },
  })
  const response = { setHeader() {}, end(value) { this.body = JSON.parse(value) } }
  await handler({ method: 'POST', ip: '127.0.0.1', body: {
    title: 'Native logs', description: 'Problem in native application', repository: 'C1ean-dev/Lira',
    rawFiles: [{ name: 'native.log', content: 'native event' }], logSummaries: { Native: 'native diagnostics' },
  } }, response)
  assert.equal(response.statusCode, 201)
  assert.equal(calls[1].url, 'https://api.github.com/repos/C1ean-dev/lira-clean/issues')
  assert.ok(JSON.parse(calls[1].options.body).body.includes('https://gist.github.com/test/123'))
  assert.equal(response.body.issueUrl, 'https://github.com/C1ean-dev/lira-clean/issues/1')
})

test('the server exposes an isolated native reporting route', async () => {
  const { readFile } = await import('node:fs/promises')
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8')
  assert.match(server, /app\.all\('\/report-issue\/lira-clean',[\s\S]*?createIssueReporterHandler\(\{\s*targetRepository: 'C1ean-dev\/lira-clean'/)
  assert.match(server, /app\.all\('\/report-issue',.*createIssueReporterHandler\(\)\)/)
})

test('native reports publish clickable original files and embed screenshots', async () => {
  const { createHash } = await import('node:crypto')
  const data = Buffer.from('png-content')
  const calls = []
  const handler = createIssueReporterHandler({
    env: { GITHUB_REPORT_TOKEN: 'test-token' }, targetRepository: 'C1ean-dev/lira-clean',
    attachmentBaseUrl: 'https://lira-signaling.onrender.com/report-issue/lira-clean/attachments',
    fetch: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, json: async () => ({ html_url: url.endsWith('/gists') ? 'https://gist.github.com/test/abcdef1234' : 'https://github.com/C1ean-dev/lira-clean/issues/1', number: 1 }) }
    },
  })
  const response = { setHeader() {}, end(value) { this.body = JSON.parse(value) } }
  await handler({ method: 'POST', ip: '127.0.0.1', body: {
    title: 'Screenshot', description: 'The screenshot shows the problem',
    rawFiles: [
      { name: 'anexos-manifesto.json', content: JSON.stringify([{ name: 'image.png', size: data.length, sha256: createHash('sha256').update(data).digest('hex'), parts: ['anexo-001.parte-001.b64'] }]) },
      { name: 'anexo-001.parte-001.b64', content: data.toString('base64') },
    ],
  } }, response)
  const issue = JSON.parse(calls[1].options.body)
  assert.match(issue.body, /!\[image\.png\]\(https:\/\/lira-signaling.onrender.com\/report-issue\/lira-clean\/attachments\/abcdef1234\/0\)/)
  assert.match(issue.body, /Baixar image\.png/)
  assert.equal(response.body.attachments[0].name, 'image.png')
  assert.equal(response.body.attachments[0].size, data.length)
})
