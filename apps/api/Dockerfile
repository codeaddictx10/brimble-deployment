FROM node:24-bookworm-slim

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api apps/api
COPY packages/core packages/core

RUN pnpm install --frozen-lockfile=false

EXPOSE 4000

CMD ["pnpm", "--filter", "@brimble/api", "start"]
