# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS relay-builder
WORKDIR /src
COPY scripts/build-relay.sh ./scripts/build-relay.sh

# Koyeb injects matching service env vars/secrets as Docker build args in the
# builder stage only; the final runtime stage never inherits these values.
ARG LIRA_BUILD_RELAY=""
ARG LIRA_RELAY_SOURCE_TOKEN=""
ARG GITHUB_RELEASES_TOKEN=""
ARG GITHUB_REPORT_TOKEN=""
ARG GITHUB_TOKEN=""
ARG CARGO_BUILD_JOBS="2"

RUN set -eu; \
  mkdir -p /out; \
  token="${LIRA_RELAY_SOURCE_TOKEN:-}"; \
  if [ -z "$token" ] && [ "${LIRA_BUILD_RELAY:-}" = "1" ]; then \
    token="${GITHUB_RELEASES_TOKEN:-${GITHUB_REPORT_TOKEN:-${GITHUB_TOKEN:-}}}"; \
  fi; \
  if [ "${LIRA_BUILD_RELAY:-}" != "0" ] && [ -n "$token" ]; then \
    apt-get update && apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates cmake curl pkg-config libssl-dev && \
    rm -rf /var/lib/apt/lists/*; \
    CARGO_BUILD_JOBS="$CARGO_BUILD_JOBS" LIRA_RELAY_SOURCE_TOKEN="$token" bash ./scripts/build-relay.sh; \
    strip relay/target/release/lira-p2p-node || true; \
    cp relay/target/release/lira-p2p-node /out/lira-p2p-node; \
  fi

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=9000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js publicHost.mjs joinPage.js publicRooms.js turnCredentials.js issueReporter.js reportAttachments.mjs liraUpdates.mjs nativeUpdates.mjs p2pCatalog.mjs p2pRelay.mjs ./
COPY join-page ./join-page
COPY --from=relay-builder /out/ /usr/local/bin/

RUN mkdir -p /app/.lira-p2p && chown -R node:node /app
USER node

EXPOSE 9000
CMD ["node", "server.js"]
