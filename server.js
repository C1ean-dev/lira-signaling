import express from 'express'
import { createServer } from 'node:http'
import { ExpressPeerServer } from 'peer'
import { WebSocketServer } from 'ws'
import { createPublicRoomsHub } from './publicRooms.js'
import { createTurnCredentialsHandler } from './turnCredentials.js'
import { createIssueReporterHandler } from './issueReporter.js'
import { createReportAttachmentHandler } from './reportAttachments.mjs'
import { createNativeUpdates } from './nativeUpdates.mjs'
import { createP2PCatalog, CATALOG_PATH } from './p2pCatalog.mjs'
import { createP2PRelayProxy, startManagedP2PRelay } from './p2pRelay.mjs'
import { createJoinPageRouter } from './joinPage.js'

const port = process.env.PORT || 9000

const app = express()
// Render terminates TLS and supplies the client address through one proxy.
app.set('trust proxy', 1)
app.use('/join', createJoinPageRouter())
app.all(CATALOG_PATH, express.json({limit:'128kb'}), createP2PCatalog())
app.get('/health', (_req,res)=>res.json({ok:true}))
app.all('/turn/credentials', createTurnCredentialsHandler())
app.all('/report-issue', express.json({ limit: '10mb' }), createIssueReporterHandler())
app.all('/report-issue/lira-clean', express.json({ limit: '10mb' }), createIssueReporterHandler({
  targetRepository: 'C1ean-dev/lira-clean',
  attachmentBaseUrl: 'https://lira-signaling.onrender.com/report-issue/lira-clean/attachments',
}))
app.get('/report-issue/lira-clean/attachments/:gistId/:index', createReportAttachmentHandler())
const nativeUpdates = createNativeUpdates()
app.get('/updates/lira-clean/latest', nativeUpdates.latest)
app.get('/updates/lira-clean/assets/:assetId', nativeUpdates.asset)
const httpServer = createServer(app)
const relayUpgrade=createP2PRelayProxy()
let stopRelay=()=>{}
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
const rooms = createPublicRoomsHub(roomsSocketServer)
httpServer.on('upgrade', (request, socket, head) => {
  let path
  try { path = new URL(request.url, 'http://localhost').pathname } catch { socket.destroy(); return }
  if(path==='/p2p/relay'){relayUpgrade(request,socket,head);return}
  const target = path === '/rooms' ? roomsSocketServer : path === signalingPath ? signalingSocketServer : null
  if (!target) { socket.destroy(); return }
  target.handleUpgrade(request, socket, head, ws => target.emit('connection', ws, request))
})
httpServer.on('close', () => {rooms.close();stopRelay()})
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stopRelay();httpServer.close(()=>process.exit(0));setTimeout(()=>process.exit(0),5000).unref()})
server.on('error', error => console.error('[P2P Server]', error))
roomsSocketServer.on('error', error => console.error('[Rooms Server]', error))

server.on('connection', (client) => {
  console.log(`[P2P Server] Peer conectado: ${client.getId()}`)
})

server.on('disconnect', (client) => {
  console.log(`[P2P Server] Peer desconectado: ${client.getId()}`)
})

httpServer.listen(Number(port), '0.0.0.0', () => {
  stopRelay=startManagedP2PRelay()
  console.log(`Servidor de Sinalizacao Lira ativo na porta ${httpServer.address().port}`)
})
