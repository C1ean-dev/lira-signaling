import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'

// Render's existing Node build runs npm install/ci. Keep local installs cheap.
export function buildOnRender({env=process.env,run=execFileSync,warn=console.warn}={}) {
  if(env.RENDER !== 'true')return false
  const token=env.LIRA_RELAY_SOURCE_TOKEN || env.GITHUB_RELEASES_TOKEN || env.GITHUB_REPORT_TOKEN || env.GITHUB_TOKEN
  if(token) {
    run('bash',[fileURLToPath(new URL('./build-relay.sh',import.meta.url))],{
      stdio:'inherit',env:{...env,LIRA_RELAY_SOURCE_TOKEN:token},
    })
    return true
  }
  if(!env.LIRA_P2P_RELAY_BIN)warn('Catálogo P2P habilitado. Relay aguardando token GitHub com leitura de C1ean-dev/lira-clean na Render.')
  return false
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))buildOnRender()
