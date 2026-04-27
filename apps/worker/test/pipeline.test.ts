import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

import { createStore, renderCaddyfile } from "@brimble/core/server";
import { describe, expect, it } from "vitest";

import type { WorkerConfig } from "../src/config";
import { processDeploymentJob } from "../src/pipeline";

function buildConfig(databasePath: string): WorkerConfig {
  return {
    databasePath,
    workspaceRoot: join(tmpdir(), "brimble-workspaces"),
    uploadRoot: join(tmpdir(), "brimble-uploads"),
    buildkitHost: "tcp://buildkitd:1234",
    runtimeNetwork: "brimble_runtime",
    caddyAdminUrl: "http://caddy:2019/load",
    caddyConfigPath: join(tmpdir(), "brimble-caddy", "Caddyfile"),
    publicBaseUrl: "http://localhost:8080",
    appPort: 3000,
    pollIntervalMs: 5
  };
}

describe("processDeploymentJob", () => {
  it("marks a successful deployment as running and renders route config", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "brimble-worker-"));
    const databasePath = join(fixtureDir, "worker.sqlite");
    const store = createStore(databasePath, { publicBaseUrl: "http://localhost:8080" });
    const deployment = store.createDeployment({
      sourceType: "git",
      repoUrl: "https://github.com/octocat/Hello-World",
      routeType: "path",
      routeValue: "sample-app"
    });
    const claimedJob = store.claimNextJob();

    if (!claimedJob) {
      throw new Error("Expected a claimed job for test.");
    }

    const writtenConfigs: string[] = [];

    try {
      await processDeploymentJob(claimedJob, buildConfig(databasePath), {
        store,
        async runCommand(_command, _args, options) {
          options?.onStdout?.("ok");
        },
        async removeContainer() {},
        async startContainer() {},
        async waitForHttp() {},
        async writeCaddyConfig(configText) {
          writtenConfigs.push(configText);
        },
        async reloadCaddy() {},
        async cleanupWorkspace() {}
      });

      const storedDeployment = store.getDeployment(deployment.id);
      expect(storedDeployment?.status).toBe("running");
      expect(storedDeployment?.imageTag).toBe(`brimble-deployment-${deployment.id}:latest`);
      expect(storedDeployment?.containerName).toBe(`brimble-app-${deployment.id}`);
      expect(writtenConfigs[0]).toContain("path-app-sample-app.127.0.0.1.sslip.io");
    } finally {
      store.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("marks failed deployments as failed while retaining logs", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "brimble-worker-failure-"));
    const databasePath = join(fixtureDir, "worker.sqlite");
    const store = createStore(databasePath, { publicBaseUrl: "http://localhost:8080" });
    const deployment = store.createDeployment({
      sourceType: "git",
      repoUrl: "https://github.com/octocat/Hello-World",
      routeType: "host",
      routeValue: "broken-preview"
    });
    const claimedJob = store.claimNextJob();

    if (!claimedJob) {
      throw new Error("Expected a claimed job for test.");
    }

    try {
      await processDeploymentJob(claimedJob, buildConfig(databasePath), {
        store,
        async runCommand(command, _args, options) {
          options?.onStderr?.(`${command} failed`);
          throw new Error("build exploded");
        },
        async removeContainer() {},
        async startContainer() {},
        async waitForHttp() {},
        async writeCaddyConfig() {},
        async reloadCaddy() {},
        async cleanupWorkspace() {}
      });

      const storedDeployment = store.getDeployment(deployment.id);
      const logs = store.getLogsAfter(deployment.id, 0);

      expect(storedDeployment?.status).toBe("failed");
      expect(storedDeployment?.failureReason).toContain("build exploded");
      expect(logs.length).toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("extracts uploaded archives before building", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "brimble-worker-upload-"));
    const databasePath = join(fixtureDir, "worker.sqlite");
    const uploadArchivePath = join(fixtureDir, "sample-app.zip");
    writeFileSync(uploadArchivePath, "fake zip bytes");

    const store = createStore(databasePath, { publicBaseUrl: "http://localhost:8080" });
    const deployment = store.createDeployment({
      sourceType: "upload",
      uploadFileName: "sample-app.zip",
      uploadPath: uploadArchivePath,
      routeType: "path",
      routeValue: "uploaded-app"
    });
    const claimedJob = store.claimNextJob();

    if (!claimedJob) {
      throw new Error("Expected a claimed job for test.");
    }

    const commands: Array<{ command: string; args: string[] }> = [];

    try {
      await processDeploymentJob(claimedJob, buildConfig(databasePath), {
        store,
        async runCommand(command, args, options) {
          commands.push({ command, args });

          if (command === "unzip") {
            const extractPath = args[args.indexOf("-d") + 1];
            const projectRoot = join(extractPath, "sample-app");
            await mkdir(projectRoot, { recursive: true });
            writeFileSync(join(projectRoot, "package.json"), "{\"name\":\"sample-app\"}");
          }

          options?.onStdout?.("ok");
        },
        async removeContainer() {},
        async startContainer() {},
        async waitForHttp() {},
        async writeCaddyConfig() {},
        async reloadCaddy() {},
        async cleanupWorkspace() {}
      });

      expect(commands.some(({ command }) => command === "git")).toBe(false);
      expect(commands.some(({ command }) => command === "unzip")).toBe(true);
      expect(commands.find(({ command }) => command === "railpack")?.args.at(-1)).toContain(
        "/upload/sample-app"
      );

      const storedDeployment = store.getDeployment(deployment.id);
      expect(storedDeployment?.status).toBe("running");
    } finally {
      store.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

describe("queue serialization", () => {
  it("prevents claiming a second job while one is processing", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "brimble-worker-queue-"));
    const databasePath = join(fixtureDir, "queue.sqlite");
    const store = createStore(databasePath, { publicBaseUrl: "http://localhost:8080" });

    try {
      store.createDeployment({
        sourceType: "git",
        repoUrl: "https://github.com/octocat/Hello-World",
        routeType: "path",
        routeValue: "one"
      });
      store.createDeployment({
        sourceType: "git",
        repoUrl: "https://github.com/octocat/Spoon-Knife",
        routeType: "host",
        routeValue: "two"
      });

      const firstJob = store.claimNextJob();
      const secondJob = store.claimNextJob();

      expect(firstJob).not.toBeNull();
      expect(secondJob).toBeNull();
    } finally {
      store.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

describe("renderCaddyfile", () => {
  it("renders both path and host routes", () => {
    const configText = renderCaddyfile([
      {
        id: "dep_path",
        routeType: "path",
        routeValue: "dashboard",
        containerName: "path-app"
      },
      {
        id: "dep_host",
        routeType: "host",
        routeValue: "preview",
        containerName: "host-app"
      }
    ]);

    expect(configText).toContain("path-app-dashboard.127.0.0.1.sslip.io");
    expect(configText).toContain("preview.127.0.0.1.sslip.io");
  });
});
