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
is added for horizontal scaling. The optional AMQP relay below shares room metadata
between server instances; active rooms still expire rather than being persisted.

## Optional CloudAMQP / RabbitMQ relay

Set `CLOUDAMQP_URL` in the Render service's secret environment variables to the
provided AMQPS URL (`amqps://USERNAME:PASSWORD@HOST/VHOST`). Redeploy the server
after merging this change. Do not use a `VITE_` variable or put the actual URL in
the app, README, GitHub comments, or committed files. `.env.example` contains only
a placeholder; `npm start` reads the deployment environment, not a `.env` file.

The server connects over TLS (normally port 5671), with heartbeat, automatic
reconnection and publisher confirmations. It uses the durable fanout exchange
`lira.public-rooms.v1` and one exclusive auto-deleting queue per instance. Queue
messages expire after 20 seconds and are bounded to 1000 entries. Announcements
contain only validated public room metadata; avatars are excluded. Offline
messages are not queued; local rooms are announced again when AMQP reconnects.
Each connection has a seven-second setup timeout and each confirmation has a
five-second timeout. Unconfirmed publishing is bounded and respects backpressure.

The app still connects through `/rooms`, with no broker credentials. When AMQP
is configured, `READY.services` and `SERVICE_STATUS.services` include
`{name: "RabbitMQ", host: "broker hostname", status: "connecting|connected|disconnected"}`.
Only a successful publisher confirmation generates `ROOM_PUBLISHED` with
`service`, `roomId`, `hostId`, optional `announcementId`, and `timestamp`. An
announcement originating from RabbitMQ includes `publicationServices: ["RabbitMQ"]`.
Clients must discard confirmations for a previous room/host/announcement or after
the service disconnects. These protocol fields are optional for compatibility.

RabbitMQ is reached through Render: it does not provide an independent client
connection if Render is unavailable. Render discovery and PeerJS continue to work
when AMQP is unavailable or not configured. No MQTT plugin or port 8883 is needed
for this integration.

To test the account without advertising synthetic rooms, provide
`CLOUDAMQP_TEST_URL` only to the test process and run
`node --test test/cloudamqp.integration.test.mjs`. It authenticates over TLS and
publishes/confirms/consumes one message in a private temporary queue. The test
skips without this variable and redacts credentials on failure.

## Tests and deployment

`npm test` runs the room registry tests and an integration test covering both
WebSocket endpoints and the existing PeerJS HTTP endpoint on the same port.

Deploy this version to the Render service together with the matching Lira app
integration. The discovery endpoint is an addition to the existing signaling
protocol. Older app versions continue using PeerJS normally. The updated app
continues querying EMQX and HiveMQ if Render is unavailable or still running
the earlier signaling-only version.
