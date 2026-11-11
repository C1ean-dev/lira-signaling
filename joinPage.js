import express from 'express'
import { fileURLToPath } from 'node:url'

/** A separate, stateless bridge from public HTTPS invitations to the installed app. */
export function createJoinPageRouter() {
  const router = express.Router()
  const directory = fileURLToPath(new URL('./join-page/', import.meta.url))
  router.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
    })
    next()
  })
  router.get('/', (_req, res) => res.sendFile('index.html', { root: directory }))
  for (const asset of ['invite.js', 'launch.js', 'invite.css', 'logo.svg']) {
    router.get(`/${asset}`, (_req, res) => res.sendFile(asset, { root: directory }))
  }
  router.all('/', (_req, res) => res.set('Allow', 'GET, HEAD').status(405).end())
  router.use((_req, res) => res.status(404).end())
  return router
}
