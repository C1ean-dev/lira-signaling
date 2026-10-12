import { PeerServer } from 'peer'

const port = process.env.PORT || 9000

const server = PeerServer({
  port: Number(port),
  path: '/',
  allow_discovery: true,
})

server.on('connection', (client) => {
  console.log(`[P2P Server] Peer conectado: ${client.getId()}`)
})

server.on('disconnect', (client) => {
  console.log(`[P2P Server] Peer desconectado: ${client.getId()}`)
})

console.log(`Servidor de Sinalizacao Lira ativo na porta ${port}`)
