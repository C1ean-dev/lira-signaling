import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildAttachmentLinks, attachmentMarkdown, createReportAttachmentHandler } from '../reportAttachments.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64')
function files(bytes = png) {
  return [
    { name: 'anexos-manifesto.json', content: JSON.stringify([{ name: 'image.png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), parts: ['anexo-001.parte-001.b64'] }]) },
    { name: 'anexo-001.parte-001.b64', content: bytes.toString('base64') },
  ]
}
function response() {
  return { headers: {}, statusCode: 200, setHeader(key, value) { this.headers[key] = value }, end(body) { this.body = body } }
}
test('report images have a downloadable original and an inline GitHub image', async () => {
  const raw = files()
  const links = buildAttachmentLinks('https://gist.github.com/lira/abcdef1234', raw, 'https://lira-signaling.onrender.com/report-issue/lira-clean/attachments')
  assert.match(attachmentMarkdown(links), /!\[image\.png\]\(https:/)
  assert.match(attachmentMarkdown(links), /Baixar image\.png/)
  const handler = createReportAttachmentHandler({ fetch: async () => new Response(JSON.stringify({ description: 'Logs da Issue: native', files: Object.fromEntries(raw.map(file => [file.name, file])) })) })
  const res = response()
  await handler({ method: 'GET', params: { gistId: 'abcdef1234', index: '0' } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Content-Type'], 'image/png')
  assert.match(res.headers['Content-Disposition'], /inline.*image\.png/)
  assert.deepEqual(res.body, png)
})
test('incomplete or tampered files are rejected instead of returning corrupt downloads', async () => {
  const raw = files()
  raw[1].content = Buffer.from('tampered').toString('base64')
  const handler = createReportAttachmentHandler({ fetch: async () => new Response(JSON.stringify({ description: 'Logs da Issue: native', files: Object.fromEntries(raw.map(file => [file.name, file])) })) })
  const res = response()
  await handler({ method: 'GET', params: { gistId: 'abcdef1234', index: '0' } }, res)
  assert.equal(res.statusCode, 404)
})
test('raw redirects and arbitrary hosts never receive the GitHub credential', async () => {
  const raw = files()
  const data = Object.fromEntries(raw.map(file => [file.name, file]))
  data[raw[1].name] = { truncated: true, raw_url: 'https://example.com/private' }
  let calls = 0
  const handler = createReportAttachmentHandler({ env: { GITHUB_REPORT_TOKEN: 'private' }, fetch: async () => {
    calls++
    return new Response(JSON.stringify({ description: 'Logs da Issue: native', files: data }))
  } })
  const res = response()
  await handler({ method: 'GET', params: { gistId: 'abcdef1234', index: '0' } }, res)
  assert.equal(res.statusCode, 404)
  assert.equal(calls, 1)
})
test('active content is downloaded and invalid identifiers are rejected', async () => {
  const raw = files(Buffer.from('<html><script>alert(1)</script></html>'))
  const handler = createReportAttachmentHandler({ fetch: async () => new Response(JSON.stringify({ description: 'Logs da Issue: native', files: Object.fromEntries(raw.map(file => [file.name, file])) })) })
  const res = response()
  await handler({ method: 'GET', params: { gistId: 'abcdef1234', index: '0' } }, res)
  assert.equal(res.headers['Content-Type'], 'application/octet-stream')
  assert.match(res.headers['Content-Disposition'], /^attachment/)
  const invalid = response()
  await handler({ method: 'GET', params: { gistId: '../secrets', index: '0' } }, invalid)
  assert.equal(invalid.statusCode, 404)
})
