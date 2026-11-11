import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { gunzipSync } from 'node:zlib'
import { chromium } from 'playwright'
import { createJoinPageRouter } from '../joinPage.js'

test('HTTPS invitations open the bridge, preserve the app link and offer installation', { timeout: 45000 }, async t => {
  const app = express()
  app.use('/join', createJoinPageRouter())
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  let browser
  t.after(async () => {
    await browser?.close()
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  })
  browser = await chromium.launch({ headless: true, executablePath: process.env.LIRA_CHROMIUM_EXECUTABLE || undefined })
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const requests = []
  const errors = []
  await page.route('**/join/launch.js', route => route.fulfill({ contentType: 'text/javascript', body:
    'export function launchNativeInvite(link){(window.attemptedNativeLinks ??= []).push(link)}' }))
  page.on('request', request => requests.push(request.url()))
  page.on('pageerror', error => errors.push(error.message))
  const invite = 'LIRA-ALL:' + Buffer.from(JSON.stringify({ version: 1, room: 'ROOM', signaling: 'render', direct: {
    version: 1, kind: 'offer', session: 'browser-session', room: 'ROOM', host: 'lira-ROOM-host',
    guest: 'lira-ROOM-peer-Guest', expiresAt: Date.now() + 600000, description: { type: 'offer', sdp: 'v=0\r\na=MixedCASE+/-_\r\n' },
  } })).toString('base64url')
  const url = origin + '/join#invite=' + encodeURIComponent(invite)
  await page.goto(url)
  const open = page.getByRole('link', { name: 'Abrir no Lira', exact: true })
  const native = new URL(await open.getAttribute('href'))
  assert.equal(native.protocol, 'lira:')
  assert.equal(native.searchParams.get('invite'), invite)
  assert.deepEqual(await page.evaluate(() => window.attemptedNativeLinks), [native.href], 'loading the invitation automatically attempts to open Lira once')
  assert.equal(await page.getByRole('link', { name: 'Baixar Lira', exact: true }).getAttribute('href'), 'https://github.com/C1ean-dev/Lira/releases/latest')
  assert.equal(await page.getByRole('link', { name: 'Baixar Lira', exact: true }).getAttribute('target'), '_blank')
  assert.ok(requests.every(request => !request.includes('LIRA-ALL') && !request.includes('invite=')), 'the invitation must never be part of an HTTP request')
  await open.click()
  assert.deepEqual(await page.evaluate(() => window.attemptedNativeLinks), [native.href, native.href], 'the button retries with a user gesture when automatic opening is blocked')
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    async writeText(value) { window.copiedInvite = value },
  } }))
  await page.getByRole('button', { name: 'Copiar convite para colar no Lira' }).click()
  assert.equal(await page.evaluate(() => window.copiedInvite), invite)
  await page.reload()
  assert.equal(new URL(await open.getAttribute('href')).searchParams.get('invite'), invite, 'the same invitation remains after installation or reload')
  const screenshots = process.env.LIRA_JOIN_SCREENSHOTS || path.join(os.tmpdir(), 'lira-join-page')
  await fs.mkdir(screenshots, { recursive: true })
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 900 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px should have no horizontal overflow`)
    assert.ok(await open.isVisible())
    await page.screenshot({ path: path.join(screenshots, `${width}.png`), fullPage: true })
  }
  const longInvite = 'LIRA-ALL:' + Buffer.from(JSON.stringify({ version: 1, room: 'ROOM', signaling: 'render', direct: {
    version: 1, kind: 'offer', room: 'ROOM', session: 'long-session', host: 'lira-ROOM-host', guest: 'lira-ROOM-peer-Guest',
    expiresAt: Date.now() + 600000, description: { type: 'offer', sdp: 'v=0\r\n' + 'a=candidate:MixedCASE 192.168.1.20\r\n'.repeat(60) },
  } })).toString('base64url')
  await page.goto(origin + '/join#invite=' + encodeURIComponent(longInvite))
  await open.waitFor()
  const packed = new URL(await open.getAttribute('href'))
  assert.ok(packed.href.length < 2081)
  assert.equal(gunzipSync(Buffer.from(packed.searchParams.get('inviteGzip'), 'base64url')).toString('utf8'), longInvite)
  assert.equal(await page.evaluate(() => window.attemptedNativeLinks.at(-1)), packed.href)
  assert.equal(await page.evaluate(() => window.attemptedNativeLinks.length), 2, 'changing to a new invitation attempts it once')
  const expired = 'LIRA-ALL:' + Buffer.from(JSON.stringify({ version: 1, room: 'ROOM', direct: {
    version: 1, kind: 'offer', session: 'expired-session', room: 'ROOM', host: 'lira-ROOM-host',
    guest: 'lira-ROOM-peer-Guest', expiresAt: 1, description: { type: 'offer', sdp: 'v=0' },
  } })).toString('base64url')
  await page.goto(origin + '/join#invite=' + encodeURIComponent(expired))
  await page.getByRole('status').filter({ hasText: 'expirou' }).waitFor()
  assert.equal(await open.count(), 0)
  assert.ok(await page.getByRole('link', { name: 'Baixar Lira', exact: true }).isVisible())
  await page.goto(origin + '/join#invite=' + encodeURIComponent('<img src=x onerror=alert(1)>'))
  await page.getByRole('status').filter({ hasText: 'inválido' }).waitFor()
  assert.equal(await page.locator('img[src=x]').count(), 0)
  assert.deepEqual(errors, [])
  t.diagnostic('Bridge screenshots: ' + screenshots)
})
