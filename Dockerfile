# syntax=docker/dockerfile:1
# Garage kit, self-hosted: the same Worker code as the Cloudflare deploy, run by workerd (via Miniflare) behind a
# small Node server (docker/server.mjs). Data in /data. Docs: docs/docker.md
ARG NODE_IMAGE=node:22-bookworm-slim

# 1. Bundle the Worker once, on the build machine's own architecture (the bundle is plain JavaScript).
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS bundle
WORKDIR /src
ENV WRANGLER_SEND_METRICS=false CI=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY wrangler.docker.jsonc ./
RUN npx wrangler deploy --dry-run --outdir dist/worker --config wrangler.docker.jsonc \
 && rm -f dist/worker/*.map dist/worker/README.md

# 2. Runtime dependencies for the target architecture (workerd ships a native binary per platform).
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# sharp (image resizing for Miniflare's Images binding) is never used here: drop it and its libvips (~30 MB)
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
 && rm -rf node_modules/sharp node_modules/@img

# 3. The image.
FROM ${NODE_IMAGE}
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="garage-kit" \
      org.opencontainers.image.description="Self-hosted household car-maintenance app with an AI mechanic and an MCP server for Claude" \
      org.opencontainers.image.source="https://github.com/Taylorshome/garage-kit" \
      org.opencontainers.image.url="https://github.com/Taylorshome/garage-kit" \
      org.opencontainers.image.documentation="https://github.com/Taylorshome/garage-kit/blob/main/docs/docker.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production DATA_DIR=/data PORT=8787 GARAGE_DOCKER=self
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=bundle /src/dist ./dist
COPY package.json package-lock.json LICENSE THIRD_PARTY_LICENSES.md ./
COPY public ./public
COPY migrations ./migrations
COPY docker ./docker
COPY scripts ./scripts
COPY src ./src
COPY demo ./demo
# /app/build: scratch space for the kit's scripts; /app/backups -> /data/backups (their pre-write backups persist)
RUN printf '#!/bin/sh\nexec node /app/docker/cli.mjs "$@"\n' > /usr/local/bin/garage \
 && chmod 755 /usr/local/bin/garage \
 && mkdir -p /data /app/build && chown node:node /data /app/build \
 && ln -s /data/backups /app/backups
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/docker/server.mjs"]
