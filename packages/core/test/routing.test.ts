import { describe, expect, it } from "vitest";

import { renderCaddyfile, resolveLiveUrl } from "../src/client";

describe("resolveLiveUrl", () => {
  it("resolves path-mode URLs", () => {
    expect(
      resolveLiveUrl(
        {
          routeType: "path",
          routeValue: "demo-app"
        },
        "http://localhost:8080"
      )
    ).toBe("http://localhost:8080/apps/demo-app");
  });

  it("resolves host-mode URLs", () => {
    expect(
      resolveLiveUrl(
        {
          routeType: "host",
          routeValue: "preview-demo"
        },
        "http://localhost:8080"
      )
    ).toBe("http://preview-demo.127.0.0.1.sslip.io:8080");
  });
});

describe("renderCaddyfile", () => {
  it("renders path and host routes into a single ingress config", () => {
    const configText = renderCaddyfile([
      {
        id: "dep_path",
        routeType: "path",
        routeValue: "demo-app",
        containerName: "demo-container"
      },
      {
        id: "dep_host",
        routeType: "host",
        routeValue: "preview-demo",
        containerName: "preview-container"
      }
    ]);

    expect(configText).toContain("path-app-demo-app.127.0.0.1.sslip.io");
    expect(configText).toContain("preview-demo.127.0.0.1.sslip.io");
    expect(configText).toContain("reverse_proxy api:4000");
  });
});
