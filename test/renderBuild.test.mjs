import test from 'node:test'
import assert from 'node:assert/strict'
import {buildOnRender} from '../scripts/render-build.mjs'

test('Render builds the relay using an existing GitHub credential without requiring another variable',()=>{
  for(const name of ['GITHUB_RELEASES_TOKEN','GITHUB_REPORT_TOKEN','GITHUB_TOKEN']) {
    let called=false
    const secret='test-private-read-credential'
    assert.equal(buildOnRender({env:{RENDER:'true',[name]:secret},warn:()=>assert.fail('A configured token must not be reported as missing'),run:(file,args,options)=>{
      called=true
      assert.equal(file,'bash')
      assert.ok(args[0].endsWith('build-relay.sh'))
      assert.equal(options.env.LIRA_RELAY_SOURCE_TOKEN,secret)
      assert.ok(!JSON.stringify(args).includes(secret),'Credentials stay out of process arguments and printed commands')
    }}),true)
    assert.equal(called,true)
  }
})

test('a dedicated read credential takes priority over a reporting credential',()=>{
  buildOnRender({env:{RENDER:'true',LIRA_RELAY_SOURCE_TOKEN:'read-only',GITHUB_REPORT_TOKEN:'issue-writer'},run:(_file,_args,options)=>{
    assert.equal(options.env.LIRA_RELAY_SOURCE_TOKEN,'read-only')
  }})
})

test('a repository name is not treated as a credential and ordinary npm installs do not build Rust',()=>{
  let warnings=[]
  const run=()=>assert.fail('No private-source build should run')
  assert.equal(buildOnRender({env:{RENDER:'true',GITHUB_REPO:'C1ean-dev/lira-clean'},run,warn:value=>warnings.push(value)}),false)
  assert.equal(warnings.length,1)
  assert.equal(buildOnRender({env:{GITHUB_TOKEN:'existing'},run}),false)
})
