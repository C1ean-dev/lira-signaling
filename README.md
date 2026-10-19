# Lira signaling and public room discovery

Run `npm install` and `npm start` on Node.js 20 or newer. The server listens on
`PORT` (9000 by default), preserving PeerJS HTTP routes and the `/peerjs`
WebSocket endpoint. No database or additional Render service is required.

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

## Tests and deployment

`npm test` runs the room registry tests and an integration test covering both
WebSocket endpoints and the existing PeerJS HTTP endpoint on the same port.

Deploy this version to the Render service together with the matching Lira app
integration. The discovery endpoint is an addition to the existing signaling
protocol. Older app versions continue using PeerJS normally. The updated app
continues querying EMQX and HiveMQ if Render is unavailable or still running
the earlier signaling-only version.
