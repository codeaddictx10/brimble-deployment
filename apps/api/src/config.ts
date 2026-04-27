import { DEFAULT_PUBLIC_BASE_URL } from "@brimble/core/server";

export interface ApiConfig {
  databasePath: string;
  port: number;
  publicBaseUrl: string;
  ssePollIntervalMs: number;
  uploadRoot: string;
  uploadMaxBytes: number;
}

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    databasePath: env.DATABASE_PATH ?? "/data/brimble.sqlite",
    port: readNumber(env.PORT, 4000),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL,
    ssePollIntervalMs: readNumber(env.SSE_POLL_INTERVAL_MS, 1000),
    uploadRoot: env.UPLOAD_ROOT ?? "/data/uploads",
    uploadMaxBytes: readNumber(env.UPLOAD_MAX_BYTES, 50 * 1024 * 1024)
  };
}
