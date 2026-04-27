import { DatabaseSync } from "node:sqlite";

import {
  buildRouteTarget,
  DEFAULT_PUBLIC_BASE_URL,
  toDeploymentView
} from "./routing";
import type {
  ClaimedJob,
  CreateDeploymentInput,
  DeploymentLogRecord,
  DeploymentRecord,
  DeploymentRouteTarget,
  DeploymentView,
  LogStream,
  UpdateDeploymentPatch,
  WorkerJobRecord
} from "./types";

interface StoreOptions {
  publicBaseUrl?: string;
}

type DeploymentRow = {
  id: string;
  source_type: DeploymentRecord["sourceType"];
  repo_url: string;
  upload_file_name: string | null;
  upload_path: string | null;
  status: DeploymentRecord["status"];
  image_tag: string | null;
  route_type: DeploymentRecord["routeType"];
  route_value: string;
  container_name: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type LogRow = {
  deployment_id: string;
  sequence: number;
  stream: LogStream;
  message: string;
  created_at: string;
};

type WorkerJobRow = {
  id: string;
  deployment_id: string;
  status: WorkerJobRecord["status"];
  locked_at: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
};

type SqlRow = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function asDeploymentRow(row: SqlRow): DeploymentRow {
  return row as DeploymentRow;
}

function asLogRow(row: SqlRow): LogRow {
  return row as LogRow;
}

function asWorkerJobRow(row: SqlRow): WorkerJobRow {
  return row as WorkerJobRow;
}

function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");

  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function isSqliteBusyError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR" && /database is locked/i.test(error.message);
}

function blockFor(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Block briefly to give the other migrator time to release the lock.
  }
}

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as SqlRow[];
  return rows.some((row) => row.name === columnName);
}

function toDeploymentRecord(row: DeploymentRow): DeploymentRecord {
  return {
    id: row.id,
    sourceType: row.source_type,
    repoUrl: row.repo_url || null,
    uploadFileName: row.upload_file_name,
    uploadPath: row.upload_path,
    status: row.status,
    imageTag: row.image_tag,
    routeType: row.route_type,
    routeValue: row.route_value,
    containerName: row.container_name,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

function toLogRecord(row: LogRow): DeploymentLogRecord {
  return {
    deploymentId: row.deployment_id,
    sequence: row.sequence,
    stream: row.stream,
    message: row.message,
    createdAt: row.created_at
  };
}

function toWorkerJobRecord(row: WorkerJobRow): WorkerJobRecord {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    status: row.status,
    lockedAt: row.locked_at,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function applyPatchStatement(id: string, patch: UpdateDeploymentPatch): {
  sql: string;
  values: Array<string | null>;
} {
  const updates: string[] = ["updated_at = ?"];
  const values: Array<string | null> = [nowIso()];

  if (patch.status !== undefined) {
    updates.push("status = ?");
    values.push(patch.status);
  }

  if (patch.imageTag !== undefined) {
    updates.push("image_tag = ?");
    values.push(patch.imageTag);
  }

  if (patch.containerName !== undefined) {
    updates.push("container_name = ?");
    values.push(patch.containerName);
  }

  if (patch.failureReason !== undefined) {
    updates.push("failure_reason = ?");
    values.push(patch.failureReason);
  }

  if (patch.startedAt !== undefined) {
    updates.push("started_at = ?");
    values.push(patch.startedAt);
  }

  if (patch.completedAt !== undefined) {
    updates.push("completed_at = ?");
    values.push(patch.completedAt);
  }

  values.push(id);

  return {
    sql: `UPDATE deployments SET ${updates.join(", ")} WHERE id = ?`,
    values
  };
}

function runMigrations(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      upload_file_name TEXT,
      upload_path TEXT,
      status TEXT NOT NULL,
      image_tag TEXT,
      route_type TEXT NOT NULL,
      route_value TEXT NOT NULL,
      container_name TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deployment_logs (
      deployment_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      stream TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (deployment_id, sequence),
      FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS worker_jobs (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      locked_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
    );
  `);

  if (!hasColumn(db, "deployments", "upload_file_name")) {
    db.exec("ALTER TABLE deployments ADD COLUMN upload_file_name TEXT");
  }

  if (!hasColumn(db, "deployments", "upload_path")) {
    db.exec("ALTER TABLE deployments ADD COLUMN upload_path TEXT");
  }
}

export function createStore(databasePath: string, options: StoreOptions = {}) {
  const db = new DatabaseSync(databasePath);
  const publicBaseUrl = options.publicBaseUrl ?? DEFAULT_PUBLIC_BASE_URL;

  db.exec("PRAGMA busy_timeout = 5000;");

  let migrationAttempts = 0;
  while (true) {
    try {
      runMigrations(db);
      break;
    } catch (error) {
      migrationAttempts += 1;

      if (!isSqliteBusyError(error) || migrationAttempts >= 5) {
        throw error;
      }

      blockFor(250);
    }
  }

  const createDeploymentTxn = (input: CreateDeploymentInput) =>
    runInTransaction(db, () => {
      const timestamp = nowIso();
      const deploymentId = createId("dep");
      const jobId = createId("job");

      db.prepare(
        `
          INSERT INTO deployments (
            id,
            source_type,
            repo_url,
            upload_file_name,
            upload_path,
            status,
            image_tag,
            route_type,
            route_value,
            container_name,
            failure_reason,
            created_at,
            updated_at,
            started_at,
            completed_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, NULL, ?, ?, NULL, NULL)
        `
      ).run(
        deploymentId,
        input.sourceType,
        input.sourceType === "git" ? input.repoUrl : "",
        input.sourceType === "upload" ? input.uploadFileName : null,
        input.sourceType === "upload" ? input.uploadPath : null,
        input.routeType,
        input.routeValue,
        timestamp,
        timestamp
      );

      db.prepare(
        `
          INSERT INTO worker_jobs (
            id,
            deployment_id,
            status,
            locked_at,
            attempt_count,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      ).run(jobId, deploymentId, "pending", null, 0, timestamp, timestamp);

      return deploymentId;
    });

  const appendLogTxn = (deploymentId: string, stream: LogStream, message: string): DeploymentLogRecord =>
    runInTransaction(db, () => {
      const timestamp = nowIso();
      const result = db.prepare(
        `
          SELECT COALESCE(MAX(sequence), 0) + 1 AS nextSequence
          FROM deployment_logs
          WHERE deployment_id = ?
        `
      ).get(deploymentId) as SqlRow | undefined;
      const sequence = Number(result?.nextSequence ?? 1);

      db.prepare(
        `
          INSERT INTO deployment_logs (
            deployment_id,
            sequence,
            stream,
            message,
            created_at
          ) VALUES (?, ?, ?, ?, ?)
        `
      ).run(deploymentId, sequence, stream, message, timestamp);

      return {
        deploymentId,
        sequence,
        stream,
        message,
        createdAt: timestamp
      };
    });

  const getDeploymentRow = (deploymentId: string): DeploymentRow | undefined =>
    (() => {
      const row = db.prepare(
        `
          SELECT *
          FROM deployments
          WHERE id = ?
        `
      ).get(deploymentId) as SqlRow | undefined;

      return row ? asDeploymentRow(row) : undefined;
    })();

  return {
    close(): void {
      db.close();
    },

    createDeployment(input: CreateDeploymentInput): DeploymentView {
      const deploymentId = createDeploymentTxn(input);
      const row = getDeploymentRow(deploymentId);

      if (!row) {
        throw new Error(`Deployment ${deploymentId} was not persisted.`);
      }

      return toDeploymentView(toDeploymentRecord(row), publicBaseUrl);
    },

    findActiveDeploymentForRoute(routeType: DeploymentRecord["routeType"], routeValue: string) {
      const row = db.prepare(
        `
          SELECT *
          FROM deployments
          WHERE route_type = ?
            AND route_value = ?
            AND status IN ('pending', 'building', 'deploying', 'running')
          ORDER BY created_at DESC
          LIMIT 1
        `
      ).get(routeType, routeValue) as SqlRow | undefined;

      return row ? toDeploymentRecord(asDeploymentRow(row)) : null;
    },

    listDeployments(): DeploymentView[] {
      const rows = db.prepare(
        `
          SELECT *
          FROM deployments
          ORDER BY created_at DESC
        `
      ).all() as SqlRow[];

      return rows.map((row) =>
        toDeploymentView(toDeploymentRecord(asDeploymentRow(row)), publicBaseUrl)
      );
    },

    getDeployment(deploymentId: string): DeploymentView | null {
      const row = getDeploymentRow(deploymentId);
      return row ? toDeploymentView(toDeploymentRecord(row), publicBaseUrl) : null;
    },

    getDeploymentRecord(deploymentId: string): DeploymentRecord | null {
      const row = getDeploymentRow(deploymentId);
      return row ? toDeploymentRecord(row) : null;
    },

    appendLog(deploymentId: string, stream: LogStream, message: string): DeploymentLogRecord {
      return appendLogTxn(deploymentId, stream, message);
    },

    getLogsAfter(deploymentId: string, afterSequence = 0, limit = 250): DeploymentLogRecord[] {
      const rows = db.prepare(
        `
          SELECT *
          FROM deployment_logs
          WHERE deployment_id = ?
            AND sequence > ?
          ORDER BY sequence ASC
          LIMIT ?
        `
      ).all(deploymentId, afterSequence, limit) as SqlRow[];

      return rows.map((row) => toLogRecord(asLogRow(row)));
    },

    updateDeployment(deploymentId: string, patch: UpdateDeploymentPatch): void {
      const statement = applyPatchStatement(deploymentId, patch);
      db.prepare(statement.sql).run(...statement.values);
    },

    claimNextJob(): ClaimedJob | null {
      const transaction = () =>
        runInTransaction(db, () => {
          const activeJob = db.prepare(
            `
              SELECT id
              FROM worker_jobs
              WHERE status = 'processing'
              LIMIT 1
            `
          ).get() as SqlRow | undefined;

          if (activeJob) {
            return null;
          }

          const row = db.prepare(
            `
              SELECT *
              FROM worker_jobs
              WHERE status = 'pending'
              ORDER BY created_at ASC
              LIMIT 1
            `
          ).get() as SqlRow | undefined;

          if (!row) {
            return null;
          }

          const jobRow = asWorkerJobRow(row);

          const timestamp = nowIso();
          const updateResult = db.prepare(
            `
              UPDATE worker_jobs
              SET status = 'processing',
                  locked_at = ?,
                  attempt_count = attempt_count + 1,
                  updated_at = ?
              WHERE id = ?
                AND status = 'pending'
            `
          ).run(timestamp, timestamp, jobRow.id);

          if (updateResult.changes === 0) {
            return null;
          }

          const deploymentRow = getDeploymentRow(String(jobRow.deployment_id));
          if (!deploymentRow) {
            throw new Error(
              `Deployment ${String(jobRow.deployment_id)} is missing for claimed job ${jobRow.id}.`
            );
          }

          return {
            job: toWorkerJobRecord({
              ...jobRow,
              status: "processing",
              locked_at: timestamp,
              attempt_count: Number(jobRow.attempt_count) + 1,
              updated_at: timestamp
            }),
            deployment: toDeploymentRecord(deploymentRow)
          } satisfies ClaimedJob;
        });

      return transaction();
    },

    completeJob(jobId: string): void {
      const timestamp = nowIso();
      db.prepare(
        `
          UPDATE worker_jobs
          SET status = 'completed',
              locked_at = NULL,
              updated_at = ?
          WHERE id = ?
        `
      ).run(timestamp, jobId);
    },

    failJob(jobId: string): void {
      const timestamp = nowIso();
      db.prepare(
        `
          UPDATE worker_jobs
          SET status = 'failed',
              locked_at = NULL,
              updated_at = ?
          WHERE id = ?
        `
      ).run(timestamp, jobId);
    },

    resetInFlightWork(): void {
      const timestamp = nowIso();

      db.prepare(
        `
          UPDATE deployments
          SET status = 'pending',
              failure_reason = NULL,
              updated_at = ?
          WHERE status IN ('building', 'deploying')
        `
      ).run(timestamp);

      db.prepare(
        `
          UPDATE worker_jobs
          SET status = 'pending',
              locked_at = NULL,
              updated_at = ?
          WHERE status = 'processing'
        `
      ).run(timestamp);
    },

    listRunningRouteTargets(includeDeploymentId?: string): DeploymentRouteTarget[] {
      const rows = db.prepare(
        `
          SELECT *
          FROM deployments
          WHERE (status = 'running' OR id = ?)
            AND container_name IS NOT NULL
          ORDER BY created_at ASC
        `
      ).all(includeDeploymentId ?? null) as SqlRow[];

      return rows
        .map((row) => buildRouteTarget(toDeploymentRecord(asDeploymentRow(row))))
        .filter((target): target is DeploymentRouteTarget => target !== null);
    }
  };
}

export type BrimbleStore = ReturnType<typeof createStore>;
