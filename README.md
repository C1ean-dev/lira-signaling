# Lira signaling and public room discovery

Run `npm install` and `npm start` on Node.js 20 or newer. The server listens on
`PORT` (9000 by default), preserving PeerJS HTTP routes and the `/peerjs`
WebSocket endpoint. No database or additional Render service is required.

## HTTPS space invitations

`GET /join` serves the standalone invitation page, with its assets under `/join/`.
Share links shaped as `https://lira-signaling.onrender.com/join#invite=...`.
The fragment contains the original invitation with its casing preserved; it is
read only by the visitor's browser, without sending SDP, addresses or credentials
to the HTTP server. No database, new secret or other service is needed.

The page automatically attempts to open Lira once for each invitation and offers
**Abrir no Lira** to retry with a user gesture when the browser requires one.
Small invitations use `lira://join?invite=...`; larger ones use gzip with
`lira://join?inviteGzip=...` to stay within Windows' 2081-character external-URL
limit. The HTTPS fragment and copied original invitation remain unchanged.
The page also offers the official Lira download page. Visitors without the app can install it,
return to the same page and open the invitation. The browser may ask to confirm
launching the application. Expired direct-only invitations request a new link;
complete invitations with signaling or IPv6 routes remain usable. The installed
app must include support for the `lira://` protocol and compressed invitations.

This endpoint does not register peers or rooms and does not alter the existing
PeerJS, `/rooms`, `/turn/credentials`, reporting, native updates or P2P routes.
Tests: `node --test test/joinPage.test.mjs test/server.test.mjs`.
Browser checks after installing the development dependencies and a Playwright
Chromium browser: `npm run test:join:browser`.

## Public rooms

Connect to `wss://lira-signaling.onrender.com/rooms`. The server sends
`{"type":"READY","protocolVersion":1}` once the discovery connection is ready.
All following messages are JSON:

- `QUERY_ROOMS`: returns each active room as an `ANNOUNCE_ROOM` message.
- `ANNOUNCE_ROOM` with `roomInfo`: registers or updates the connection's room.
- `HEARTBEAT` with `roomInfo`: refreshes its metadata and expiry.
- `UNREGISTER_ROOM` with `roomId`: removes the connection's room.

Room metadata includes `id`, `code`, `name`, `hostId`, `hostName`, `playerCount`,
`maxPlayers`, `color` and optional description, host color, announcement ID and
zone count. Avatars and unknown fields are excluded. Packets are limited to
16 KiB. Announcements and removals are broadcast to connected discovery clients.

Each connection can advertise one room and cannot overwrite or remove another
connection's active room. This ownership check is not user authentication.
Rooms expire after 20 seconds without a heartbeat and are removed when the
owning connection closes. State is held in memory; after a server restart,
clients reconnect and announce again. Use one instance unless shared room state
is added for horizontal scaling.

## Cloudflare TURN credentials

`GET /turn/credentials` issues temporary TURN credentials for the Lira client.
Configure `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN` as secret
environment variables on Render and redeploy. The application is `lirasvg`.
Keep the API token on the backend; it must never be bundled in a frontend or
committed. GitHub Secrets with these names are safe storage but are not
automatically injected into a running Render service.

Each request creates credentials with a 24-hour lifetime and returns only
`{ iceServers, expiresAt }`. Responses use `Cache-Control: no-store`; CORS permits
the desktop, web and Android clients without cookies. Issuance is bounded to ten
requests per minute per IP (behind Render's proxy), with a four-second upstream
timeout. Errors are generic and never include upstream bodies or API tokens.
An unconfigured server returns 503, and upstream failures return 502, allowing
the client to fall back to Metered. Existing PeerJS and discovery routes are
preserved.

Run `node --test test/turnCredentials.test.mjs test/server.test.mjs` to test the
issuer with a mocked Cloudflare API and the HTTP route with no external calls.

## Anonymous issue reporter (`issuesReporter`)

`POST /report-issue` provides an anonymous bug reporting endpoint for Lira clients,
creating GitHub issues (and secret diagnostic Gists) without exposing GitHub tokens
to frontend client bundles.

### Configuration

Set the following environment variables:

- `GITHUB_REPORT_TOKEN` (or `GITHUB_TOKEN`): GitHub Personal Access Token with permissions to create issues and secret gists (`repo` and `gist` scopes).
- `GITHUB_REPO`: Target repository in `owner/repo` format (defaults to `C1ean-dev/Lira` if omitted).

### Request format

Accepts `POST` requests with JSON payloads up to 10 MB:

```json
{
  "title": "Audio distortion when entering room",
  "description": "Steps to reproduce and observed behavior...",
  "systemInfo": {
    "appVersion": "1.1.117",
    "os": "win32",
    "electron": "33.0.0",
    "chrome": "130.0.6723.44",
    "node": "20.18.0",
    "timestamp": "2026-11-03T22:00:00.000Z"
  },
  "rawFiles": [
    { "name": "lira-debug.log", "content": "Log content..." }
  ],
  "logSummaries": {
    "Recent Logs": "Last 50 log lines..."
  }
}
```

- `title`: String between 3 and 250 characters (required).
- `description`: String between 5 and 50,000 characters (required).
- `systemInfo`: Optional object with client environment metadata, formatted as bullet points in the issue.
- `rawFiles`: Optional array of `{ name, content }` objects (files up to 500 KB each). When provided, the server creates a private GitHub Gist and automatically links it in an alert box within the issue.
- `logSummaries`: Optional key-value object rendered as collapsible `<details>` sections.
- `body`: Optional markdown string that completely overrides automatic template formatting.

### Responses and error handling

- `201 Created`: Returns `{ ok: true, issueUrl, issueNumber, gistUrl? }`.
- `400 Bad Request`: Validation failure on title or description length.
- `429 Too Many Requests`: Per-IP rate limiting (maximum 5 submissions per 1-hour window per IP, includes `Retry-After` header with remaining seconds).
- `502 Bad Gateway`: GitHub API upstream error or timeout (8s timeout for issues, 6s for gists).
- `503 Service Unavailable`: Server lacks configured GitHub token.

CORS headers are set to allow requests from any origin (`*`), and `OPTIONS` preflight requests return `204 No Content`. Sensitive credentials are kept strictly server-side.

Run `node --test test/issueReporter.test.mjs` to test the issue reporter with mocked GitHub endpoints and rate limiting validation.

## Environment variables summary

| Variable | Required | Description | Default |
| --- | --- | --- | --- |
| `PORT` | No | HTTP and WebSocket listening port | `9000` |
| `CLOUDFLARE_TURN_KEY_ID` | Yes (for TURN) | Cloudflare Calls TURN key ID | - |
| `CLOUDFLARE_TURN_API_TOKEN` | Yes (for TURN) | Cloudflare Calls TURN API token | - |
| `GITHUB_REPORT_TOKEN` | Yes (for issues) | GitHub PAT for creating issues and secret gists | - |
| `GITHUB_REPO` | No | Target repository (`owner/repo`) for reported issues | `C1ean-dev/Lira` |

## Tests and deployment

Run the test suite:

```bash
npm test
```

This runs all tests using Node's native test runner (`node --test`), covering:
- Room discovery protocol and heartbeat expiration (`test/publicRooms.test.mjs`)
- Cloudflare TURN credentials generation and rate limiting (`test/turnCredentials.test.mjs`)
- Anonymous issue reporting with GitHub API & Gist integration (`test/issueReporter.test.mjs`)
- Server integration with PeerJS, WebSockets, and HTTP routes on the same port (`test/server.test.mjs`)

Deploy this version to the Render service together with the matching Lira app
integration. The PeerJS signaling, WebSocket room discovery, TURN credentials,
and issue reporting endpoints all run concurrently on a single port. Older app
versions continue using PeerJS normally.

## Catálogo nativo e relay WSS

### Serviço Node existente na Render

Mantenha o runtime **Node**, build `npm ci` (ou `npm install`) e start `npm start`.
O build reutiliza os tokens existentes, nesta ordem: `LIRA_RELAY_SOURCE_TOKEN`,
`GITHUB_RELEASES_TOKEN`, `GITHUB_REPORT_TOKEN` e `GITHUB_TOKEN`. A credencial
selecionada precisa de **Contents: Read** no repositório privado
`C1ean-dev/lira-clean`. Não é necessário criar outro token se o atual já tem
essa permissão. `GITHUB_REPO` indica o repositório de issues e não é um token.
O `postinstall` detecta `RENDER=true`, obtém uma revisão fixa do núcleo privado,
instala as ferramentas de build necessárias e compila `relay/`. O servidor
inicia esse executável automaticamente e anuncia seu endereço WSS.
O proxy usa automaticamente a escuta local do relay (`127.0.0.1:9001` por padrão)
na Render; `LIRA_P2P_RELAY_UPSTREAM` só é necessário para sobrescrever esse destino.
O fonte obtido e a credencial não são incluídos neste repositório público. Não use
`--ignore-scripts` no build da Render. A primeira compilação leva mais tempo.
Sem uma credencial, o catálogo funciona, mas o relay permanece desativado e isso
é informado nos logs. Adicionar a credencial exige refazer o deploy/build.

Depois do deploy, `/health` deve retornar 200, `/p2p/catalog/v1` deve retornar
JSON com `version: 1` e o catálogo deve ganhar o anúncio assinado do relay.
Um catálogo vazio com HTTP 200 ainda não confirma que o relay está disponível.

O estado padrão do Node fica em `.lira-p2p/relay`. Para conservar a identidade
entre deploys, monte um disco persistente e aponte `LIRA_P2P_RELAY_DATA` para ele.
`LIRA_P2P_CATALOG_FILE` pode apontar para o mesmo disco. Sem disco, os clientes
precisam buscar o catálogo atualizado após uma troca de identidade do servidor.

`GET /p2p/catalog/v1` entrega anúncios públicos assinados e temporários.
`POST` recebe até 16 anúncios e oito fontes, valida a identidade Ed25519/PeerID,
os endereços e a validade e retorna o catálogo. O cache tem até 128 nós e
limite de 120 registros por minuto/IP. Não recebe convites ou chaves de salas.
`LIRA_P2P_CATALOG_FILE` permite persistência opcional. Os clientes recompõem o
cache em memória após um reinício se não houver disco persistente.

`/p2p/relay` aceita upgrade WebSocket e encaminha os bytes ao upstream **local
fixo** de `LIRA_P2P_RELAY_UPSTREAM`. Não escolhe destinos a partir da requisição.
`LIRA_P2P_RELAY_BIN` inicia e supervisiona `lira-p2p-node`; preserve sua pasta de
dados. Na Render, o host público vem de `RENDER_EXTERNAL_HOSTNAME`, TLS é
terminado na borda e o nó anuncia o caminho seguro `/p2p/relay` e registra sua
identidade nos catálogos. Outros provedores podem definir o endereço multiaddr
em `LIRA_P2P_RELAY_ADVERTISE` e a URL de catálogo em `LIRA_P2P_CATALOG_URL`.

O executável precisa ser compilado a partir da versão de `lira-clean` que contém
WebSocket. `scripts/Prepare-Render-P2P.ps1` nesse projeto reúne as fontes do relay
e deste serviço com um Dockerfile de múltiplos estágios. Use `/health` para o
health check e armazenamento gravável/persistente em `/var/lib/lira`. As rotas
PeerJS, salas, TURN, relatórios e atualizações permanecem disponíveis no mesmo
servidor HTTP. `npm test` cobre o catálogo HTTP, o proxy binário e essas rotas.
