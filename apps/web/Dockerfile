FROM node:24-bookworm-slim

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/core packages/core

RUN pnpm install --frozen-lockfile=false

RUN pnpm rebuild esbuild
RUN pnpm --filter @brimble/web build

EXPOSE 3000

CMD ["pnpm", "--filter", "@brimble/web", "preview"]
