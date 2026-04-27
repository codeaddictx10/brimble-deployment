import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDeploymentSchema, createStore, createUploadDeploymentSchema } from "@brimble/core/server";
import { describe, expect, it } from "vitest";

function buildStore() {
  const fixtureDir = mkdtempSync(join(tmpdir(), "brimble-api-"));
  const databasePath = join(fixtureDir, "test.sqlite");
  const store = createStore(databasePath, { publicBaseUrl: "http://localhost:8080" });

  return {
    store,
    cleanup() {
      store.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  };
}

describe("API contract inputs", () => {
  it("accepts a valid GitHub deployment payload", () => {
    const result = createDeploymentSchema.safeParse({
      repoUrl: "https://github.com/octocat/Hello-World",
      routeType: "path",
      routeValue: "hello-world"
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      repoUrl: "https://github.com/octocat/Hello-World",
      routeType: "path",
      routeValue: "hello-world"
    });
  });

  it("rejects invalid GitHub URLs", () => {
    const result = createDeploymentSchema.safeParse({
      repoUrl: "https://gitlab.com/example/repo",
      routeType: "path",
      routeValue: "invalid"
    });

    expect(result.success).toBe(false);
  });

  it("accepts a valid uploaded deployment payload", () => {
    const result = createUploadDeploymentSchema.safeParse({
      uploadFileName: "sample-app.zip",
      uploadPath: "/tmp/sample-app.zip",
      routeType: "host",
      routeValue: "preview-demo"
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      sourceType: "upload",
      uploadFileName: "sample-app.zip",
      uploadPath: "/tmp/sample-app.zip",
      routeType: "host",
      routeValue: "preview-demo"
    });
  });
});

describe("API-backed persistence contracts", () => {
  it("creates deployment records with pending status and a resolved URL", () => {
    const fixture = buildStore();

    try {
      const deployment = fixture.store.createDeployment({
        sourceType: "git",
        repoUrl: "https://github.com/octocat/Hello-World",
        routeType: "path",
        routeValue: "hello-world"
      });

      expect(deployment.status).toBe("pending");
      expect(deployment.imageTag).toBeNull();
      expect(deployment.liveUrl).toBe("http://localhost:8080/apps/hello-world");
    } finally {
      fixture.cleanup();
    }
  });

  it("lists and resolves host-mode deployments", () => {
    const fixture = buildStore();

    try {
      const deployment = fixture.store.createDeployment({
        sourceType: "git",
        repoUrl: "https://github.com/octocat/Spoon-Knife",
        routeType: "host",
        routeValue: "preview-demo"
      });

      const listedDeployments = fixture.store.listDeployments();
      const detail = fixture.store.getDeployment(deployment.id);

      expect(listedDeployments).toHaveLength(1);
      expect(listedDeployments[0].liveUrl).toBe(
        "http://preview-demo.127.0.0.1.sslip.io:8080"
      );
      expect(detail?.routeType).toBe("host");
      expect(detail?.liveUrl).toBe("http://preview-demo.127.0.0.1.sslip.io:8080");
    } finally {
      fixture.cleanup();
    }
  });

  it("stores uploaded deployments with source metadata intact", () => {
    const fixture = buildStore();

    try {
      const deployment = fixture.store.createDeployment({
        sourceType: "upload",
        uploadFileName: "sample-app.zip",
        uploadPath: "/data/uploads/upload-sample-app.zip",
        routeType: "path",
        routeValue: "uploaded-app"
      });

      const stored = fixture.store.getDeploymentRecord(deployment.id);

      expect(stored?.sourceType).toBe("upload");
      expect(stored?.uploadFileName).toBe("sample-app.zip");
      expect(stored?.uploadPath).toBe("/data/uploads/upload-sample-app.zip");
      expect(stored?.repoUrl).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });
});
