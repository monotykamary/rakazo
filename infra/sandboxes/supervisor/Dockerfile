FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS bun

FROM node:24-bookworm@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY bunfig.toml bun.lock package.json ./
COPY patches patches
COPY vendor/pi-kit vendor/pi-kit
# Frozen installs need the complete workspace manifest graph, even with a production filter.
COPY packages packages
COPY apps apps
COPY infra infra
COPY scripts scripts
RUN bun install --frozen-lockfile --production --filter "@rakazo/sandbox-supervisor..."
WORKDIR /app/infra/sandboxes/supervisor
CMD ["bun", "run", "tsx", "src/index.ts"]
