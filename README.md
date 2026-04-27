# Brimble Submission Scaffold

Greenfield TypeScript monorepo for a local deployment flow built around `docker compose up`.

## Stack

- `apps/web`: Vite + React + TanStack Router + TanStack Query
- `apps/api`: Express + TypeScript
- `apps/worker`: background deployment worker + Railpack orchestration
- `packages/core`: shared routing, validation, SQLite store, and queue helpers
- `sample-app`: fixture repo used by smoke/integration workflows
- `infra/caddy`: bootstrap Caddyfile

## Local startup

1. `docker compose up --build`
2. Open `http://localhost:8080`

The worker expects the host Docker socket to be available and uses `buildkitd` plus the Railpack CLI for image builds.

## API

- `POST /api/deployments`
- `GET /api/deployments`
- `GET /api/deployments/:id`
- `GET /api/deployments/:id/logs/stream`

`POST /api/deployments` accepts either:

- JSON for a public GitHub repository URL
- `multipart/form-data` with an `archive` `.zip` upload plus `routeType` and `routeValue`

## Routing

- Path mode: `http://localhost:8080/apps/<slug>`
- Host mode: `http://<slug>.127.0.0.1.sslip.io:8080`

## Tests

- `pnpm test`
- `RUN_DOCKER_TESTS=1 pnpm test:integration`

## Smoke flow

After `docker compose up`, queue a repo from the UI or run:

```bash
pnpm smoke https://github.com/octocat/Hello-World path hello-world
```

To test an uploaded project, switch the form source to `Upload zip` and submit a zipped project root from the dashboard.

---

## Architecture

**Services.** Caddy sits at `:8080` and reverse-proxies `/api*` to the Express API and everything else to the Vite/React frontend. Deployed app containers live on the `brimble_runtime` Docker network and are reached by Caddy via their container name.

**Deployment flow.** Submitting a repo creates a `deployments` row (`pending`) and a `worker_jobs` row in SQLite. The worker polls the queue, claims one job at a time, clones the repo (or unpacks the zip), builds an image with `railpack build` via BuildKit, starts the container, then hot-reloads Caddy via its admin API — all without restarting anything.

**Status lifecycle.** `pending → building → deploying → running` (or `failed`). Each transition appends a `system` log entry.

**Log streaming.** Build output is written to `deployment_logs` with a monotonic `sequence`. The SSE endpoint polls that table and pushes new rows as `log` events; status changes emit a separate `status` event. The React client deduplicates by sequence so reconnects are safe.

**Resilience.** On startup, there is a function re-queues any jobs that were mid-flight when the worker last crashed. Railpack builds retry once (1.5s delay) on recognised transient errors (connection resets, EOF, TLS timeouts); all other failures go straight to `failed`.

**`packages/core`.** Shared library (no browser-unsafe imports on the client path) containing all TypeScript types, the SQLite store with auto-migrations, URL/Caddyfile rendering helpers, and Zod validation schemas.
