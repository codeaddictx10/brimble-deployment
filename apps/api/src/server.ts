import { mkdir, rm } from "node:fs/promises";
import { extname } from "node:path";

import cors from "cors";
import express from "express";
import multer from "multer";
import {
  createDeploymentSchema,
  createUploadDeploymentSchema,
  createStore,
  type BrimbleStore
} from "@brimble/core/server";

import type { ApiConfig } from "./config";

interface CreateApiServerOptions {
  config: ApiConfig;
  store?: BrimbleStore;
}

function createUploadName(originalName: string): string {
  const extension = extname(originalName).toLowerCase() || ".zip";
  return `upload-${Date.now()}-${crypto.randomUUID().replace(/-/g, "")}${extension}`;
}

function describeDeploymentSource(deployment: {
  sourceType: "git" | "upload";
  repoUrl: string | null;
  uploadFileName: string | null;
}): string {
  if (deployment.sourceType === "git") {
    return deployment.repoUrl ?? "unknown repository";
  }

  return deployment.uploadFileName ?? "uploaded archive";
}

async function safeRemoveFile(path: string | undefined): Promise<void> {
  if (!path) {
    return;
  }

  await rm(path, { force: true }).catch(() => undefined);
}

function sendSseEvent(
  response: express.Response,
  eventName: string,
  payload: unknown,
  id?: number
): void {
  if (id !== undefined) {
    response.write(`id: ${id}\n`);
  }

  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function readLastSequence(request: express.Request): number {
  const candidates = [
    request.header("last-event-id"),
    typeof request.query.cursor === "string" ? request.query.cursor : undefined
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const parsed = Number.parseInt(candidate, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return 0;
}

export function createApiServer({ config, store = createStore(config.databasePath, config) }: CreateApiServerOptions) {
  const app = express();
  const upload = multer({
    storage: multer.diskStorage({
      destination: async (_request, _file, callback) => {
        try {
          await mkdir(config.uploadRoot, { recursive: true });
          callback(null, config.uploadRoot);
        } catch (error) {
          callback(error as Error, config.uploadRoot);
        }
      },
      filename: (_request, file, callback) => {
        callback(null, createUploadName(file.originalname));
      }
    }),
    limits: {
      fileSize: config.uploadMaxBytes
    },
    fileFilter: (_request, file, callback) => {
      const extension = extname(file.originalname).toLowerCase();
      if (extension !== ".zip") {
        callback(new Error("Uploaded projects must be provided as a .zip archive."));
        return;
      }

      callback(null, true);
    }
  });

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_request, response) => {
    response.json({ ok: true });
  });

  app.post("/api/deployments", (request, response, next) => {
    upload.single("archive")(request, response, (error) => {
      if (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : "Failed to process uploaded archive."
        });
        return;
      }

      next();
    });
  });

  app.post("/api/deployments", async (request, response) => {
    const isUploadRequest = request.body.sourceType === "upload" || Boolean(request.file);
    const result = isUploadRequest
      ? createUploadDeploymentSchema.safeParse({
          routeType: request.body.routeType,
          routeValue: request.body.routeValue,
          uploadFileName: request.file?.originalname,
          uploadPath: request.file?.path
        })
      : createDeploymentSchema.safeParse(request.body);

    if (!result.success) {
      await safeRemoveFile(request.file?.path);
      response.status(400).json({
        error: "Invalid deployment payload.",
        issues: result.error.issues
      });
      return;
    }

    const existingRoute = store.findActiveDeploymentForRoute(
      result.data.routeType,
      result.data.routeValue
    );

    if (existingRoute) {
      await safeRemoveFile(request.file?.path);
      response.status(409).json({
        error: "That route is already in use by another active deployment.",
        deploymentId: existingRoute.id
      });
      return;
    }

    const deployment = store.createDeployment(result.data);
    store.appendLog(
      deployment.id,
      "system",
      `Queued deployment for ${describeDeploymentSource(deployment)} on ${deployment.routeType}:${deployment.routeValue}.`
    );

    response.status(201).json(deployment);
  });

  app.get("/api/deployments", (_request, response) => {
    response.json({
      deployments: store.listDeployments()
    });
  });

  app.get("/api/deployments/:id", (request, response) => {
    const deployment = store.getDeployment(request.params.id);

    if (!deployment) {
      response.status(404).json({ error: "Deployment not found." });
      return;
    }

    response.json({ deployment });
  });

  app.get("/api/deployments/:id/logs/stream", (request, response) => {
    const deploymentId = request.params.id;
    const deployment = store.getDeploymentRecord(deploymentId);

    if (!deployment) {
      response.status(404).json({ error: "Deployment not found." });
      return;
    }

    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    let currentSequence = readLastSequence(request);
    let lastStatus = deployment.status;

    const flushLogs = () => {
      const logs = store.getLogsAfter(deploymentId, currentSequence);

      for (const entry of logs) {
        currentSequence = entry.sequence;
        sendSseEvent(response, "log", entry, entry.sequence);
      }

      const latestDeployment = store.getDeploymentRecord(deploymentId);
      if (latestDeployment && latestDeployment.status !== lastStatus) {
        lastStatus = latestDeployment.status;
        sendSseEvent(response, "status", {
          deploymentId,
          status: latestDeployment.status,
          failureReason: latestDeployment.failureReason
        });
      }
    };

    const interval = setInterval(flushLogs, config.ssePollIntervalMs);
    const heartbeat = setInterval(() => {
      sendSseEvent(response, "ping", { ok: true });
    }, 15000);

    flushLogs();

    request.on("close", () => {
      clearInterval(interval);
      clearInterval(heartbeat);
      response.end();
    });
  });

  return { app, store };
}
