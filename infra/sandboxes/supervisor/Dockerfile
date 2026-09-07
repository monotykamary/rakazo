FROM node:24-bookworm@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY patches patches
COPY vendor/pi-kit vendor/pi-kit
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY packages/logging packages/logging
COPY infra/sandboxes/supervisor infra/sandboxes/supervisor
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter "@rakazo/sandbox-supervisor..."
WORKDIR /app/infra/sandboxes/supervisor
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
