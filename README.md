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
- `429 Too Many Requests`: Per-IP rate limiting (maximum 5 submissions per 5-minute window per IP, includes `Retry-After: 300` header).
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
