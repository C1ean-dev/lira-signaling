import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {EventEmitter,once} from 'node:events'
import {WebSocket,WebSocketServer} from 'ws'
import {createP2PRelayProxy,startManagedP2PRelay} from '../p2pRelay.mjs'

test('the WebSocket proxy forwards binary libp2p bytes to its fixed local upstream',async t=>{
  const backend=createServer();const wss=new WebSocketServer({server:backend})
  let path,cookie
  wss.on('connection',(ws,req)=>{path=req.url;cookie=req.headers.cookie;ws.on('message',(bytes,binary)=>ws.send(bytes,{binary}))})
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve))
  const proxy=createServer();proxy.on('upgrade',createP2PRelayProxy({upstream:`ws://127.0.0.1:${backend.address().port}/`}))
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve))
  t.after(()=>{for(const ws of wss.clients)ws.terminate();backend.close();proxy.close()})
  const ws=new WebSocket(`ws://127.0.0.1:${proxy.address().port}/p2p/relay?upstream=evil`,{headers:{Cookie:'must-not-be-forwarded'}})
  await once(ws,'open');const received=once(ws,'message');ws.send(Buffer.from([0,255,10,0,128]));const [bytes,binary]=await received
  assert.ok(binary);assert.deepEqual(bytes,Buffer.from([0,255,10,0,128]));assert.equal(path,'/');assert.equal(cookie,undefined)
  ws.close();await once(ws,'close')
})
test('public upstreams are rejected and an unconfigured relay returns 503',async t=>{
  assert.throws(()=>createP2PRelayProxy({upstream:'ws://example.com:9001'}),/loopback/)
  const server=createServer();server.on('upgrade',createP2PRelayProxy({}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close())
  const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/p2p/relay`);ws.on('error',()=>{})
  const status=await new Promise(resolve=>ws.on('unexpected-response',(_req,res)=>{res.resume();resolve(res.statusCode);ws.terminate()}));assert.equal(status,503)
})

test('Render Node forwards binary frames to its managed listener without an upstream environment variable',async t=>{
  const backend=createServer(),wss=new WebSocketServer({server:backend})
  wss.on('connection',ws=>ws.on('message',(data,binary)=>ws.send(data,{binary})))
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve))
  const env={RENDER:'true',LIRA_P2P_RELAY_LISTEN:`/ip4/127.0.0.1/tcp/${backend.address().port}/ws`}
  const proxy=createServer();proxy.on('upgrade',createP2PRelayProxy({env}))
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve))
  t.after(()=>{for(const ws of wss.clients)ws.terminate();backend.close();proxy.close()})
  const ws=new WebSocket(`ws://127.0.0.1:${proxy.address().port}/p2p/relay`)
  await once(ws,'open')
  const received=once(ws,'message'),payload=Buffer.from([0,255,17,128,0])
  ws.send(payload)
  const [data,binary]=await received
  assert.equal(binary,true);assert.deepEqual(data,payload)
  ws.close();await once(ws,'close')
})
test('the Render child uses a stable identity folder, native WS and the public TLS path',()=>{
  let captured,killed
  const child=new EventEmitter();child.kill=signal=>{killed=signal}
  const stop=startManagedP2PRelay({env:{LIRA_P2P_RELAY_BIN:'/app/lira-p2p-node',RENDER_EXTERNAL_HOSTNAME:'relay.example.com'},spawnProcess:(file,args,options)=>{captured={file,args,options};return child}})
  assert.ok(captured.args.includes('/dns4/relay.example.com/tcp/443/tls/x-parity-ws/%2Fp2p%2Frelay'))
  assert.ok(captured.args.includes('https://relay.example.com/p2p/catalog/v1'))
  assert.ok(captured.args.includes('https://lira-signaling.onrender.com/p2p/catalog/v1'))
  assert.equal(captured.options.windowsHide,true);stop();assert.equal(killed,'SIGTERM')
})

test('Node stores its relay identity in a writable service folder by default',()=>{
  let captured
  const child=new EventEmitter();child.kill=()=>{}
  const stop=startManagedP2PRelay({env:{LIRA_P2P_RELAY_BIN:'/app/lira-p2p-node',RENDER_EXTERNAL_HOSTNAME:'relay.example.com'},spawnProcess:(_file,args)=>{captured=args;return child}})
  assert.equal(captured[captured.indexOf('--data')+1],'.lira-p2p/relay')
  stop()
})

test('an explicit persistent identity directory survives Node and Docker configurations',()=>{
  let captured
  const child=new EventEmitter();child.kill=()=>{}
  const stop=startManagedP2PRelay({env:{LIRA_P2P_RELAY_BIN:'/app/lira-p2p-node',LIRA_P2P_RELAY_DATA:'/data/relay',RENDER_EXTERNAL_HOSTNAME:'relay.example.com'},spawnProcess:(_file,args)=>{captured=args;return child}})
  assert.equal(captured[captured.indexOf('--data')+1],'/data/relay')
  stop()
})
