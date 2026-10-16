import express from 'express'
import { createServer } from 'node:http'
import { ExpressPeerServer } from 'peer'
import { WebSocketServer } from 'ws'
import { createPublicRoomsHub } from './publicRooms.js'
import { createAmqpRoomsRelay } from './amqpRooms.js'

const port = process.env.PORT || 9000

const app = express()
const httpServer = createServer(app)
let signalingSocketServer
let signalingPath
const server = ExpressPeerServer(httpServer, {
  path: '/',
  allow_discovery: true,
  proxied: true,
  createWebSocketServer: options => {
    signalingPath = options.path
    signalingSocketServer = new WebSocketServer({ noServer: true })
    return signalingSocketServer
  },
})
app.use('/', server)

const roomsSocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
const amqpRelay = process.env.CLOUDAMQP_URL ? createAmqpRoomsRelay({ url: process.env.CLOUDAMQP_URL }) : null
const rooms = createPublicRoomsHub(roomsSocketServer, { relay: amqpRelay })
httpServer.on('upgrade', (request, socket, head) => {
  let path
  try { path = new URL(request.url, 'http://localhost').pathname } catch { socket.destroy(); return }
  const target = path === '/rooms' ? roomsSocketServer : path === signalingPath ? signalingSocketServer : null
  if (!target) { socket.destroy(); return }
  target.handleUpgrade(request, socket, head, ws => target.emit('connection', ws, request))
})
httpServer.on('close', () => { rooms.close(); void amqpRelay?.close() })
server.on('error', error => console.error('[P2P Server]', error))
roomsSocketServer.on('error', error => console.error('[Rooms Server]', error))

server.on('connection', (client) => {
  console.log(`[P2P Server] Peer conectado: ${client.getId()}`)
})

server.on('disconnect', (client) => {
  console.log(`[P2P Server] Peer desconectado: ${client.getId()}`)
})

httpServer.listen(Number(port), '0.0.0.0', () => {
  console.log(`Servidor de Sinalizacao Lira ativo na porta ${httpServer.address().port}`)
})
