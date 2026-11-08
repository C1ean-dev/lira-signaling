import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

// Render's existing Node build runs npm install/ci. Keep local installs cheap.
if(process.env.RENDER === 'true' && process.env.LIRA_RELAY_SOURCE_TOKEN) {
  execFileSync('bash',[fileURLToPath(new URL('./build-relay.sh',import.meta.url))],{stdio:'inherit'})
} else if(process.env.RENDER === 'true' && !process.env.LIRA_P2P_RELAY_BIN) {
  console.warn('Catálogo P2P habilitado. Relay aguardando LIRA_RELAY_SOURCE_TOKEN na Render para compilar o núcleo privado.')
}
