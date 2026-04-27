import type { DeploymentRecord, DeploymentRouteTarget, DeploymentView, RouteType } from "./types";

export const APP_PROXY_PREFIX = "/apps";
export const DEFAULT_PUBLIC_BASE_URL = "http://localhost:8080";
export const PATH_RUNTIME_HOST_PREFIX = "path-app";

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function buildHostUrl(hostnameLabel: string, publicBaseUrl: string): string {
  const baseUrl = new URL(publicBaseUrl);
  const port = baseUrl.port ? `:${baseUrl.port}` : "";
  return `${baseUrl.protocol}//${hostnameLabel}.127.0.0.1.sslip.io${port}`;
}

export function resolveRuntimeHostLabel(
  deployment: Pick<DeploymentRecord, "routeType" | "routeValue">
): string {
  if (deployment.routeType === "host") {
    return deployment.routeValue;
  }

  return `${PATH_RUNTIME_HOST_PREFIX}-${deployment.routeValue}`;
}

export function resolveRuntimeUrl(
  deployment: Pick<DeploymentRecord, "routeType" | "routeValue">,
  publicBaseUrl = DEFAULT_PUBLIC_BASE_URL
): string {
  return buildHostUrl(resolveRuntimeHostLabel(deployment), publicBaseUrl);
}

export function resolveLiveUrl(
  deployment: Pick<DeploymentRecord, "routeType" | "routeValue">,
  publicBaseUrl = DEFAULT_PUBLIC_BASE_URL
): string {
  const base = trimTrailingSlash(publicBaseUrl);

  if (deployment.routeType === "host") {
    return resolveRuntimeUrl(deployment, base);
  }

  return `${base}${APP_PROXY_PREFIX}/${deployment.routeValue}`;
}

function renderPathRoute(target: DeploymentRouteTarget): string {
  return [
    `  @deployment_${target.id} host ${PATH_RUNTIME_HOST_PREFIX}-${target.routeValue}.127.0.0.1.sslip.io`,
    `  handle @deployment_${target.id} {`,
    `    reverse_proxy ${target.containerName}:3000`,
    "  }"
  ].join("\n");
}

function renderHostRoute(target: DeploymentRouteTarget): string {
  return [
    `  @deployment_${target.id} host ${target.routeValue}.127.0.0.1.sslip.io`,
    `  handle @deployment_${target.id} {`,
    `    reverse_proxy ${target.containerName}:3000`,
    "  }"
  ].join("\n");
}

export function renderDynamicRoute(target: DeploymentRouteTarget): string {
  return target.routeType === "host" ? renderHostRoute(target) : renderPathRoute(target);
}

export function renderCaddyfile(targets: DeploymentRouteTarget[]): string {
  const renderedTargets = targets
    .map((target) => renderDynamicRoute(target))
    .join("\n\n");

  return `{
  admin 0.0.0.0:2019
  auto_https off
}

:80 {
${renderedTargets ? `${renderedTargets}\n` : "  # No active deployment routes yet.\n"}
  @api path /api* /healthz
  handle @api {
    reverse_proxy api:4000
  }

  handle {
    reverse_proxy web:3000
  }
}
`;
}

export function toDeploymentView(
  deployment: DeploymentRecord,
  publicBaseUrl = DEFAULT_PUBLIC_BASE_URL
): DeploymentView {
  return {
    id: deployment.id,
    sourceType: deployment.sourceType,
    repoUrl: deployment.repoUrl,
    uploadFileName: deployment.uploadFileName,
    status: deployment.status,
    imageTag: deployment.imageTag,
    routeType: deployment.routeType,
    routeValue: deployment.routeValue,
    containerName: deployment.containerName,
    failureReason: deployment.failureReason,
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
    startedAt: deployment.startedAt,
    completedAt: deployment.completedAt,
    liveUrl: resolveLiveUrl(deployment, publicBaseUrl)
  };
}

export function buildRouteTarget(
  deployment: Pick<DeploymentRecord, "id" | "routeType" | "routeValue" | "containerName">
): DeploymentRouteTarget | null {
  if (!deployment.containerName) {
    return null;
  }

  return {
    id: deployment.id,
    routeType: deployment.routeType,
    routeValue: deployment.routeValue,
    containerName: deployment.containerName
  };
}

export function isPathRoute(routeType: RouteType): boolean {
  return routeType === "path";
}
