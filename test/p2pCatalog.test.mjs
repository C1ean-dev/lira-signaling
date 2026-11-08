import test from 'node:test'
import assert from 'node:assert/strict'
import {generateKeyPairSync,sign} from 'node:crypto'
import {createServer} from 'node:http'
import {mkdtempSync,rmSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,relative,isAbsolute} from 'node:path'
import express from 'express'
import {createP2PCatalog,CATALOG_PATH,verifyAdvertisement} from '../p2pCatalog.mjs'

function base58(bytes){const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=BigInt('0x'+bytes.toString('hex')),s='';while(n){s=alphabet[Number(n%58n)]+s;n/=58n}for(const byte of bytes){if(byte)break;s='1'+s}return s}
function advertisement(change={}){
  const {publicKey,privateKey}=generateKeyPairSync('ed25519')
  const public_key=Buffer.concat([Buffer.from([8,1,18,32]),publicKey.export({type:'spki',format:'der'}).subarray(-32)])
  const peer_id=base58(Buffer.concat([Buffer.from([0,36]),public_key]))
  const now=Math.floor(Date.now()/1000)
  const node={version:1,public_key:[...public_key],peer_id,issued:now,expires:now+600,addresses:[`/ip4/8.8.8.8/tcp/4001/p2p/${peer_id}`],relay:true,...change}
  const bytes=Buffer.from(JSON.stringify(node))
  return {payload:bytes.toString('base64url'),signature:sign(null,bytes,privateKey).toString('base64url')}
}
async function serverFor(t,options={}){
  const app=express();app.all(CATALOG_PATH,express.json({limit:'128kb'}),createP2PCatalog(options));const server=createServer(app)
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}${CATALOG_PATH}`
}
const post=(url,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})

test('HTTP clients publish signed relay records and another client reads the persistent catalog',async t=>{
  const temporary=realpathSync(tmpdir()),folder=mkdtempSync(join(temporary,'lira-p2p-catalog-'))
  t.after(()=>{const resolved=realpathSync(folder),child=relative(temporary,resolved);assert.ok(child && !child.startsWith('..') && !isAbsolute(child));rmSync(resolved,{recursive:true,force:true})})
  const env={LIRA_P2P_CATALOG_FILE:join(folder,'catalog.json')}
  const url=await serverFor(t,{env})
  const record=advertisement()
  const response=await post(url,{version:1,nodes:[record],sources:['https://other.example.com/catalog','https://127.0.0.1/catalog']})
  assert.equal(response.status,200)
  const catalog=await response.json();assert.deepEqual(catalog.nodes,[record]);assert.ok(catalog.sources.includes('https://other.example.com/catalog'));assert.ok(!catalog.sources.includes('https://127.0.0.1/catalog'))
  const other=await serverFor(t,{env});assert.deepEqual((await (await fetch(other)).json()).nodes,[record])
  assert.equal((await fetch(other,{method:'DELETE'})).status,405)
  assert.equal((await post(url,{version:1,nodes:[],sources:[],roomSecret:'NEVER_STORE_ROOM_SECRETS'})).status,400)
})
test('forged signatures, stale records, private routes and unexpected room data never enter the catalog',async t=>{
  const url=await serverFor(t,{env:{}})
  const valid=advertisement(),forged={...valid,signature:'A'.repeat(86)}
  assert.ok(verifyAdvertisement(valid))
  const records=[forged,advertisement({issued:1,expires:2}),advertisement({roomSecret:'private'}),advertisement({addresses:['/ip4/192.168.1.1/tcp/4001/p2p/forged']})]
  assert.equal((await post(url,{version:1,nodes:records,sources:[]})).status,200)
  assert.deepEqual((await (await fetch(url)).json()).nodes,[])
})
test('a registration cannot impersonate a different public key or claim an unbounded lifetime',()=>{
  assert.equal(verifyAdvertisement(advertisement({peer_id:'12D3KooWother'})),null)
  assert.equal(verifyAdvertisement(advertisement({expires:Math.floor(Date.now()/1000)+86400})),null)
})
test('rate and node limits bound the public cache',()=>{
  const handler=createP2PCatalog({env:{},now:()=>1000})
  const call=()=>{const res={setHeader(){},end(body){this.body=JSON.parse(body)}};handler({method:'POST',ip:'test',body:{version:1,nodes:[],sources:[]}},res);return res}
  for(let i=0;i<120;i++)assert.equal(call().statusCode,200)
  assert.equal(call().statusCode,429)
})
test('an independent source can omit Render and cannot be forced to federate through registrations',async t=>{
  const url=await serverFor(t,{env:{RENDER_EXTERNAL_HOSTNAME:'independent.example.com',LIRA_P2P_FEDERATE_RENDER:'false'}})
  const response=await post(url,{version:1,nodes:[],sources:['https://lira-signaling.onrender.com/p2p/catalog/v1']})
  assert.deepEqual((await response.json()).sources,['https://independent.example.com/p2p/catalog/v1'])
})
