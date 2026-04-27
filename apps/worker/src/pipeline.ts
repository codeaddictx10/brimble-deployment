import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";

import {
  createStore,
  renderCaddyfile,
  resolveLiveUrl,
  resolveRuntimeHostLabel,
  type BrimbleStore,
  type ClaimedJob,
  type DeploymentRecord,
  type LogStream
} from "@brimble/core/server";

import type { WorkerConfig } from "./config";

interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}

interface WaitForHttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  intervalMs?: number;
}

const transientBuildFailurePatterns = [
  /error decoding response body/i,
  /request or response body error/i,
  /end of file before message length reached/i,
  /unexpected eof/i,
  /econnreset/i,
  /connection reset/i,
  /timed? out/i,
  /temporary failure/i,
  /tls handshake timeout/i
] as const;

export interface PipelineDependencies {
  store: BrimbleStore;
  runCommand: (command: string, args: string[], options?: RunCommandOptions) => Promise<void>;
  removeContainer: (containerName: string) => Promise<void>;
  startContainer: (options: {
    imageTag: string;
    containerName: string;
    network: string;
    port: number;
  }) => Promise<void>;
  waitForHttp: (url: string, options?: WaitForHttpOptions) => Promise<void>;
  writeCaddyConfig: (configText: string) => Promise<void>;
  reloadCaddy: (configText: string) => Promise<void>;
  cleanupWorkspace: (workspacePath: string) => Promise<void>;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createImageTag(deploymentId: string): string {
  return `brimble-deployment-${deploymentId}:latest`;
}

function createContainerName(deploymentId: string): string {
  return `brimble-app-${deploymentId}`;
}

function createIngressCheck(
  deployment: Pick<DeploymentRecord, "routeType" | "routeValue">,
  publicBaseUrl: string
): { url: string; headers?: Record<string, string> } {
  return {
    url: "http://caddy/",
    headers: {
      Host: new URL(
        deployment.routeType === "host"
          ? resolveLiveUrl(deployment, publicBaseUrl)
          : `http://${resolveRuntimeHostLabel(deployment)}.127.0.0.1.sslip.io:8080`
      ).host
    }
  };
}

function createLogger(store: BrimbleStore, deploymentId: string) {
  return (stream: LogStream, message: string) => {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }

    store.appendLog(deploymentId, stream, trimmed);
  };
}

function isTransientBuildFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return transientBuildFailurePatterns.some((pattern) => pattern.test(error.message));
}

async function buildWithRetry(
  imageTag: string,
  projectRoot: string,
  config: WorkerConfig,
  dependencies: PipelineDependencies,
  log: (stream: LogStream, message: string) => void
): Promise<void> {
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt === 1) {
      log("system", `Building ${imageTag} with Railpack.`);
    } else {
      log("system", `Retrying Railpack build for ${imageTag} after a transient failure (attempt ${attempt}/${maxAttempts}).`);
    }

    try {
      await dependencies.runCommand("railpack", ["build", "--name", imageTag, projectRoot], {
        env: {
          BUILDKIT_HOST: config.buildkitHost
        },
        onStdout: (line) => log("stdout", line),
        onStderr: (line) => log("stderr", line)
      });
      return;
    } catch (error) {
      if (attempt === maxAttempts || !isTransientBuildFailure(error)) {
        throw error;
      }

      log(
        "system",
        `Railpack build hit a transient error: ${(error as Error).message}`
      );
      await wait(1500);
    }
  }
}

async function resolveProjectRoot(extractedPath: string): Promise<string> {
  const entries = (await readdir(extractedPath, { withFileTypes: true })).filter(
    (entry) => entry.name !== "__MACOSX" && entry.name !== ".DS_Store"
  );

  if (entries.length === 0) {
    throw new Error("Uploaded archive did not contain any project files.");
  }

  const topLevelDirectories = entries.filter((entry) => entry.isDirectory());
  const topLevelFiles = entries.filter((entry) => !entry.isDirectory());

  if (topLevelDirectories.length === 1 && topLevelFiles.length === 0) {
    return join(extractedPath, topLevelDirectories[0].name);
  }

  return extractedPath;
}

async function stageDeploymentSource(
  deployment: DeploymentRecord,
  workspacePath: string,
  dependencies: PipelineDependencies,
  log: (stream: LogStream, message: string) => void
): Promise<string> {
  if (deployment.sourceType === "git") {
    log("system", `Cloning ${deployment.repoUrl} into ${workspacePath}.`);
    await dependencies.runCommand("git", [
      "clone",
      "--depth",
      "1",
      deployment.repoUrl ?? "",
      workspacePath
    ], {
      onStdout: (line) => log("stdout", line),
      onStderr: (line) => log("stderr", line)
    });

    return workspacePath;
  }

  if (!deployment.uploadPath) {
    throw new Error("Uploaded deployment is missing its source archive path.");
  }

  const extractPath = join(workspacePath, "upload");
  log(
    "system",
    `Extracting ${deployment.uploadFileName ?? basename(deployment.uploadPath)} into ${extractPath}.`
  );
  await dependencies.runCommand("unzip", ["-q", deployment.uploadPath, "-d", extractPath], {
    onStdout: (line) => log("stdout", line),
    onStderr: (line) => log("stderr", line)
  });

  const projectRoot = await resolveProjectRoot(extractPath);
  log("system", `Using extracted project root ${projectRoot}.`);
  return projectRoot;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<void> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const flushBuffer = (
    chunk: Buffer,
    buffer: string,
    onLine?: (line: string) => void
  ): string => {
    const text = `${buffer}${chunk.toString("utf8")}`;
    const lines = text.split(/\r?\n/);
    const remainder = lines.pop() ?? "";

    for (const line of lines) {
      onLine?.(line);
    }

    return remainder;
  };

  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer = flushBuffer(chunk, stdoutBuffer, options.onStdout);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer = flushBuffer(chunk, stderrBuffer, options.onStderr);
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (stdoutBuffer) {
        options.onStdout?.(stdoutBuffer);
      }

      if (stderrBuffer) {
        options.onStderr?.(stderrBuffer);
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed: ${command} ${args.join(" ")} (exit ${code ?? "unknown"})`));
    });
  });
}

export async function removeContainer(containerName: string): Promise<void> {
  try {
    await runCommand("docker", ["rm", "-f", containerName]);
  } catch {
    // The container often does not exist on first deploy; ignore that path.
  }
}

export async function startContainer(options: {
  imageTag: string;
  containerName: string;
  network: string;
  port: number;
}): Promise<void> {
  await runCommand("docker", [
    "run",
    "-d",
    "--name",
    options.containerName,
    "--network",
    options.network,
    "--network-alias",
    options.containerName,
    "-e",
    `PORT=${options.port}`,
    "-e",
    "HOST=0.0.0.0",
    options.imageTag
  ]);
}

export async function waitForHttp(url: string, options: WaitForHttpOptions = {}): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 30000;
  const intervalMs = options.intervalMs ?? 1000;
  const targetUrl = new URL(url);

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const transport = targetUrl.protocol === "https:" ? https : http;
        const request = transport.request(
          {
            protocol: targetUrl.protocol,
            hostname: targetUrl.hostname,
            port: targetUrl.port,
            path: `${targetUrl.pathname}${targetUrl.search}`,
            method: "GET",
            headers: options.headers
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          }
        );

        request.once("error", reject);
        request.end();
      });

      if (status >= 200 && status < 400) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }

    await wait(intervalMs);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

export async function writeCaddyConfig(configPath: string, configText: string): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, configText, "utf8");
}

export async function reloadCaddy(caddyAdminUrl: string, configText: string): Promise<void> {
  const response = await fetch(caddyAdminUrl, {
    method: "POST",
    headers: {
      "Content-Type": "text/caddyfile"
    },
    body: configText
  });

  if (!response.ok) {
    throw new Error(`Caddy reload failed with status ${response.status}.`);
  }
}

export async function cleanupWorkspace(workspacePath: string): Promise<void> {
  await rm(workspacePath, { recursive: true, force: true });
}

export function createPipelineDependencies(
  config: WorkerConfig,
  store = createStore(config.databasePath, { publicBaseUrl: config.publicBaseUrl })
): PipelineDependencies {
  return {
    store,
    runCommand,
    removeContainer,
    startContainer,
    waitForHttp,
    writeCaddyConfig: (configText) => writeCaddyConfig(config.caddyConfigPath, configText),
    reloadCaddy: (configText) => reloadCaddy(config.caddyAdminUrl, configText),
    cleanupWorkspace
  };
}

export async function processDeploymentJob(
  claimedJob: ClaimedJob,
  config: WorkerConfig,
  dependencies: PipelineDependencies
): Promise<void> {
  const deploymentId = claimedJob.deployment.id;
  const imageTag = createImageTag(deploymentId);
  const containerName = createContainerName(deploymentId);
  const workspacePath = join(config.workspaceRoot, deploymentId);
  const log = createLogger(dependencies.store, deploymentId);

  let containerStarted = false;

  const markFailed = async (message: string) => {
    log("system", message);
    dependencies.store.updateDeployment(deploymentId, {
      status: "failed",
      failureReason: message,
      completedAt: new Date().toISOString()
    });
    dependencies.store.failJob(claimedJob.job.id);
  };

  try {
    await dependencies.cleanupWorkspace(workspacePath);
    await mkdir(workspacePath, { recursive: true });

    dependencies.store.updateDeployment(deploymentId, {
      status: "building",
      imageTag,
      failureReason: null,
      containerName: null,
      startedAt: new Date().toISOString(),
      completedAt: null
    });

    const projectRoot = await stageDeploymentSource(
      claimedJob.deployment,
      workspacePath,
      dependencies,
      log
    );

    await buildWithRetry(imageTag, projectRoot, config, dependencies, log);

    dependencies.store.updateDeployment(deploymentId, {
      status: "deploying",
      containerName
    });

    log("system", `Starting container ${containerName}.`);
    await dependencies.removeContainer(containerName);
    await dependencies.startContainer({
      imageTag,
      containerName,
      network: config.runtimeNetwork,
      port: config.appPort
    });
    containerStarted = true;

    await dependencies.waitForHttp(`http://${containerName}:${config.appPort}/`);

    const caddyConfig = renderCaddyfile(
      dependencies.store.listRunningRouteTargets(deploymentId)
    );
    await dependencies.writeCaddyConfig(caddyConfig);
    await dependencies.reloadCaddy(caddyConfig);

    const ingressCheck = createIngressCheck(claimedJob.deployment, config.publicBaseUrl);
    await dependencies.waitForHttp(ingressCheck.url, {
      headers: ingressCheck.headers
    });

    dependencies.store.updateDeployment(deploymentId, {
      status: "running",
      completedAt: new Date().toISOString()
    });
    dependencies.store.completeJob(claimedJob.job.id);

    log("system", `Deployment running at ${resolveLiveUrl(claimedJob.deployment, config.publicBaseUrl)}.`);
  } catch (error) {
    if (containerStarted) {
      await dependencies.removeContainer(containerName);
    }

    await markFailed(error instanceof Error ? error.message : "Deployment failed.");
  } finally {
    await dependencies.cleanupWorkspace(workspacePath);
  }
}

export async function processNextDeployment(
  config: WorkerConfig,
  dependencies: PipelineDependencies
): Promise<boolean> {
  const claimedJob = dependencies.store.claimNextJob();

  if (!claimedJob) {
    return false;
  }

  await processDeploymentJob(claimedJob, config, dependencies);
  return true;
}
