import { DEFAULT_PUBLIC_BASE_URL } from "@brimble/core/server";

export interface WorkerConfig {
  databasePath: string;
  workspaceRoot: string;
  uploadRoot: string;
  buildkitHost: string;
  runtimeNetwork: string;
  caddyAdminUrl: string;
  caddyConfigPath: string;
  publicBaseUrl: string;
  appPort: number;
  pollIntervalMs: number;
}

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    databasePath: env.DATABASE_PATH ?? "/data/brimble.sqlite",
    workspaceRoot: env.WORKSPACE_ROOT ?? "/tmp/brimble/workspaces",
    uploadRoot: env.UPLOAD_ROOT ?? "/data/uploads",
    buildkitHost: env.BUILDKIT_HOST ?? "tcp://buildkitd:1234",
    runtimeNetwork: env.RUNTIME_NETWORK ?? "brimble_runtime",
    caddyAdminUrl: env.CADDY_ADMIN_URL ?? "http://caddy:2019/load",
    caddyConfigPath: env.CADDY_CONFIG_PATH ?? "/data/caddy/Caddyfile",
    publicBaseUrl: env.PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL,
    appPort: readNumber(env.APP_PORT, 3000),
    pollIntervalMs: readNumber(env.WORKER_POLL_INTERVAL_MS, 1500)
  };
}
