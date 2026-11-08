import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DEFAULT_LISTEN='/ip4/127.0.0.1/tcp/9001/ws'
function renderUpstream(env) {
  const listen=env.LIRA_P2P_RELAY_LISTEN || DEFAULT_LISTEN
  const port=/^\/ip4\/127\.0\.0\.1\/tcp\/(\d+)\/ws$/.exec(listen)?.[1]
  if(!port || Number(port)<1 || Number(port)>65535)throw new Error('Configure LIRA_P2P_RELAY_UPSTREAM for a non-default relay listener')
  return `ws://127.0.0.1:${port}/`
}

// Only a fixed loopback upstream is accepted. Request parameters never choose it.
export function createP2PRelayProxy({env=process.env,upstream,maxConnections=256} = {}) {
  upstream ??= env.LIRA_P2P_RELAY_UPSTREAM || (env.RENDER==='true' ? renderUpstream(env) : undefined)
  let target
  if (upstream) {
    target=new URL(upstream)
    if (target.protocol!=='ws:' || !['127.0.0.1','[::1]'].includes(target.hostname) || target.username || target.password || target.search || target.hash) throw new Error('P2P relay upstream must use a fixed loopback WebSocket address')
  }
  let active=0
  return function upgrade(req,socket,head) {
    if (!target || active>=maxConnections) {socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return}
    if (req.method!=='GET' || req.headers.upgrade?.toLowerCase()!=='websocket' || !req.headers['sec-websocket-key']) {socket.destroy();return}
    active++
    const backend=connect({host:target.hostname.replace(/^\[|\]$/g,''),port:Number(target.port || 80)})
    let finished=false
    const close=()=>{if(finished)return;finished=true;active--;socket.destroy();backend.destroy()}
    socket.on('error',close).on('close',close)
    backend.on('error',close).on('close',close)
    backend.setTimeout(10000,close)
    backend.once('data',()=>backend.setTimeout(0))
    backend.once('connect',()=>{
      const headers=[`GET ${target.pathname || '/'} HTTP/1.1`,`Host: ${target.host}`]
      for(const name of ['upgrade','connection','sec-websocket-key','sec-websocket-version','sec-websocket-protocol']) {
        const value=req.headers[name]
        if(typeof value==='string' && !/[\r\n]/.test(value)) headers.push(`${name}: ${value}`)
      }
      backend.write(headers.join('\r\n')+'\r\n\r\n')
      if(head.length)backend.write(head)
      socket.pipe(backend).pipe(socket)
    })
  }
}

export function startManagedP2PRelay({env=process.env,spawnProcess=spawn}={}) {
  const bundled=fileURLToPath(new URL('./relay/target/release/lira-p2p-node',import.meta.url))
  const binary=env.LIRA_P2P_RELAY_BIN || (env.RENDER==='true' && existsSync(bundled) ? bundled : '')
  if(!binary){
    if(env.RENDER==='true')console.warn('Catálogo P2P ativo; relay Rust não configurado. Configure um token GitHub com leitura de lira-clean e refaça o build com scripts npm habilitados.')
    return ()=>{}
  }
  const advertise=env.LIRA_P2P_RELAY_ADVERTISE || (env.RENDER_EXTERNAL_HOSTNAME ? `/dns4/${env.RENDER_EXTERNAL_HOSTNAME}/tcp/443/tls/x-parity-ws/%2Fp2p%2Frelay` : '')
  if(!advertise)throw new Error('LIRA_P2P_RELAY_ADVERTISE or RENDER_EXTERNAL_HOSTNAME is required for the managed native relay')
  const ownCatalog=env.LIRA_P2P_CATALOG_URL || (env.RENDER_EXTERNAL_HOSTNAME ? `https://${env.RENDER_EXTERNAL_HOSTNAME}/p2p/catalog/v1` : 'https://lira-signaling.onrender.com/p2p/catalog/v1')
  const args=['--data',env.LIRA_P2P_RELAY_DATA || '.lira-p2p/relay','--listen',env.LIRA_P2P_RELAY_LISTEN || DEFAULT_LISTEN,'--advertise',advertise]
  for(const url of new Set([ownCatalog,...(env.LIRA_P2P_FEDERATE_RENDER==='false'?[]:['https://lira-signaling.onrender.com/p2p/catalog/v1'])]))args.push('--catalog-url',url)
  let child,stopped=false,timer
  const start=()=>{
    child=spawnProcess(binary,args,{stdio:'inherit',windowsHide:true})
    let scheduled=false
    const retry=()=>{if(!stopped&&!scheduled){scheduled=true;timer=setTimeout(start,5000);timer.unref()}}
    child.once('exit',retry).once('error',retry)
  }
  start()
  return ()=>{stopped=true;clearTimeout(timer);child?.kill('SIGTERM')}
}
