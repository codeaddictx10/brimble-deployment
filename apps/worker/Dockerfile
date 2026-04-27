FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl docker.io git unzip \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
RUN curl -fsSL https://railpack.com/install.sh | sh

ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/worker apps/worker
COPY packages/core packages/core

RUN pnpm install --frozen-lockfile=false

CMD ["pnpm", "--filter", "@brimble/worker", "start"]
