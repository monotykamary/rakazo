FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS bun

# The updater is the only service that gets the Docker CLI and the Docker socket, so it is built
# separately from the application image rather than adding root-equivalent tooling to api, worker,
# and web. It is also the only service the update never recreates, so its own image moves on the
# operator's schedule: `docker compose pull updater && docker compose up -d updater`.
FROM docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c AS dockercli

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose \
  /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-buildx \
  /usr/local/libexec/docker/cli-plugins/docker-buildx
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY bunfig.toml bun.lock package.json ./
COPY patches patches
COPY vendor/pi-kit vendor/pi-kit
# Frozen installs need the complete workspace manifest graph, even with a production filter.
COPY packages packages
COPY apps apps
COPY infra infra
COPY scripts scripts
RUN bun install --frozen-lockfile --production --filter "@rakazo/updater..."
WORKDIR /app/infra/updater
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
CMD ["bun", "run", "tsx", "src/index.ts"]
