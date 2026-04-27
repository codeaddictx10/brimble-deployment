import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate
} from "@tanstack/react-router";
import {
  resolveLiveUrl,
  resolveRuntimeUrl,
  type DeploymentLogRecord,
  type DeploymentView,
  type RouteType,
  type SourceType
} from "@brimble/core";
import { z } from "zod";

import "./styles.css";

interface DeploymentsResponse {
  deployments: DeploymentView[];
}

interface DeploymentResponse {
  deployment: DeploymentView;
}

interface ApiError {
  error: string;
  issues?: Array<{ path: string[]; message: string }>;
}

type CreateDeploymentPayload =
  | {
      sourceType: "git";
      repoUrl: string;
      routeType: RouteType;
      routeValue: string;
    }
  | {
      sourceType: "upload";
      archiveFile: File;
      routeType: RouteType;
      routeValue: string;
    };

const queryClient = new QueryClient();

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as ApiError | null;
    throw new Error(errorBody?.error ?? `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

function mergeLogs(currentLogs: DeploymentLogRecord[], incomingLogs: DeploymentLogRecord[]) {
  const bySequence = new Map<number, DeploymentLogRecord>();

  for (const entry of currentLogs) {
    bySequence.set(entry.sequence, entry);
  }

  for (const entry of incomingLogs) {
    bySequence.set(entry.sequence, entry);
  }

  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function useDeploymentLogs(deploymentId: string | undefined) {
  const queryClient = useQueryClient();
  const [logs, setLogs] = useState<DeploymentLogRecord[]>([]);

  useEffect(() => {
    setLogs([]);

    if (!deploymentId) {
      return;
    }

    const eventSource = new EventSource(`/api/deployments/${deploymentId}/logs/stream`);

    const onLog = (event: MessageEvent<string>) => {
      const entry = JSON.parse(event.data) as DeploymentLogRecord;
      setLogs((currentLogs) => mergeLogs(currentLogs, [entry]));
    };

    const onStatus = () => {
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
      void queryClient.invalidateQueries({ queryKey: ["deployment", deploymentId] });
    };

    eventSource.addEventListener("log", onLog as EventListener);
    eventSource.addEventListener("status", onStatus as EventListener);

    return () => {
      eventSource.close();
    };
  }, [deploymentId, queryClient]);

  return logs;
}

function StatusPill({ status }: { status: DeploymentView["status"] }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}

function getDeploymentSourceLabel(deployment: Pick<DeploymentView, "sourceType" | "repoUrl" | "uploadFileName">) {
  if (deployment.sourceType === "git") {
    return deployment.repoUrl ?? "Unknown repository";
  }

  return deployment.uploadFileName ?? "Uploaded archive";
}

const dashboardSearchSchema = z.object({
  deploymentId: z.string().optional()
});

const rootRoute = createRootRoute({
  component: () => <Outlet />
});

function PathDeploymentPage() {
  const { routeValue } = PathRoute.useParams();
  const deploymentsQuery = useQuery({
    queryKey: ["deployments"],
    queryFn: () => fetchJson<DeploymentsResponse>("/api/deployments"),
    refetchInterval: 3000
  });

  const deployment = (deploymentsQuery.data?.deployments ?? []).find(
    (entry) => entry.routeType === "path" && entry.routeValue === routeValue
  );

  if (!deployment) {
    return (
      <main className="app-shell">
        <div className="app-shell-card">
          <p className="eyebrow">Path deployment</p>
          <h1>Preparing {routeValue}</h1>
          <p className="hero-copy">
            The deployment shell is waiting for a matching running app. If you just created it,
            give the worker a moment and refresh this page.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="app-shell-topbar">
        <div>
          <p className="eyebrow">Path deployment</p>
          <h1>{deployment.routeValue}</h1>
        </div>
        <div className="app-shell-meta">
          <StatusPill status={deployment.status} />
          <a href="/" target="_blank" rel="noreferrer">
            Open dashboard
          </a>
        </div>
      </div>

      <div className="app-frame-wrap">
        <iframe
          className="app-frame"
          title={`deployment-${deployment.id}`}
          src={resolveRuntimeUrl(deployment)}
        />
      </div>
    </main>
  );
}

function DashboardPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const [sourceType, setSourceType] = useState<SourceType>("git");
  const [repoUrl, setRepoUrl] = useState("https://github.com/codeaddictx10/react-tip-calculator");
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [routeType, setRouteType] = useState<RouteType>("path");
  const [routeValue, setRouteValue] = useState("hello-world");
  const [formError, setFormError] = useState<string | null>(null);

  const deploymentsQuery = useQuery({
    queryKey: ["deployments"],
    queryFn: () => fetchJson<DeploymentsResponse>("/api/deployments"),
    refetchInterval: 3000
  });

  const deployments = deploymentsQuery.data?.deployments ?? [];
  const selectedDeploymentId = search.deploymentId ?? deployments[0]?.id;
  const selectedDeployment = deployments.find((deployment) => deployment.id === selectedDeploymentId);

  useEffect(() => {
    if (!search.deploymentId && deployments[0]?.id) {
      void navigate({
        search: { deploymentId: deployments[0].id },
        replace: true
      });
    }
  }, [deployments, navigate, search.deploymentId]);

  const detailQuery = useQuery({
    queryKey: ["deployment", selectedDeploymentId],
    queryFn: () => fetchJson<DeploymentResponse>(`/api/deployments/${selectedDeploymentId}`),
    enabled: Boolean(selectedDeploymentId),
    refetchInterval: 3000
  });

  const logs = useDeploymentLogs(selectedDeploymentId);

  const createDeployment = useMutation({
    mutationFn: (payload: CreateDeploymentPayload) => {
      if (payload.sourceType === "upload") {
        const formData = new FormData();
        formData.set("sourceType", payload.sourceType);
        formData.set("routeType", payload.routeType);
        formData.set("routeValue", payload.routeValue);
        formData.set("archive", payload.archiveFile);

        return fetchJson<DeploymentView>("/api/deployments", {
          method: "POST",
          body: formData
        });
      }

      return fetchJson<DeploymentView>("/api/deployments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          repoUrl: payload.repoUrl,
          routeType: payload.routeType,
          routeValue: payload.routeValue
        })
      });
    },
    onSuccess: async (deployment) => {
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ["deployments"] });
      await queryClient.invalidateQueries({ queryKey: ["deployment", deployment.id] });
      void navigate({ search: { deploymentId: deployment.id } });
    }
  });

  const activeDeployment = detailQuery.data?.deployment ?? selectedDeployment;
  const liveUrl = activeDeployment ? resolveLiveUrl(activeDeployment) : null;
  const logSummary = useMemo(() => logs.slice(-80), [logs]);

  return (
    <main className="shell">
      <div className="grid">
        <section className="panel panel-form">
          <div className="panel-header">
            <p className="panel-kicker">Submit deployment</p>
            <h2>Queue a repository</h2>
            <p className="panel-copy">Choose a source, pick a route style, and let the worker take it from there.</p>
          </div>

          <form
            className="deploy-form"
            onSubmit={(event) => {
              event.preventDefault();
              setFormError(null);

              if (sourceType === "upload") {
                if (!archiveFile) {
                  setFormError("Select a .zip archive before creating an uploaded deployment.");
                  return;
                }

                createDeployment.mutate({
                  sourceType,
                  archiveFile,
                  routeType,
                  routeValue
                });
                return;
              }

              createDeployment.mutate({
                sourceType,
                repoUrl,
                routeType,
                routeValue
              });
            }}
          >
            <label>
              <span>Source</span>
              <div className="route-toggle">
                <button
                  type="button"
                  className={sourceType === "git" ? "active" : ""}
                  onClick={() => {
                    setSourceType("git");
                    setArchiveFile(null);
                    setFormError(null);
                  }}
                >
                  Git repository
                </button>
                <button
                  type="button"
                  className={sourceType === "upload" ? "active" : ""}
                  onClick={() => {
                    setSourceType("upload");
                    setFormError(null);
                  }}
                >
                  Upload zip
                </button>
              </div>
            </label>

            <label>
              <span>{sourceType === "git" ? "Public GitHub URL" : "Project archive"}</span>
              {sourceType === "git" ? (
                <input
                  value={repoUrl}
                  onChange={(event) => setRepoUrl(event.target.value)}
                  placeholder="https://github.com/octocat/Hello-World"
                />
              ) : (
                <input
                  type="file"
                  accept=".zip,application/zip"
                  onChange={(event) => {
                    setArchiveFile(event.target.files?.[0] ?? null);
                  }}
                />
              )}
            </label>

            <div className="route-toggle">
              <button
                type="button"
                className={routeType === "path" ? "active" : ""}
                onClick={() => {
                  setRouteType("path");
                  setRouteValue("hello-world");
                }}
              >
                Path route
              </button>
              <button
                type="button"
                className={routeType === "host" ? "active" : ""}
                onClick={() => {
                  setRouteType("host");
                  setRouteValue("preview-demo");
                }}
              >
                Host route
              </button>
            </div>

            <label>
              <span>{routeType === "path" ? "Path slug" : "Hostname slug"}</span>
              <input
                value={routeValue}
                onChange={(event) => setRouteValue(event.target.value)}
                placeholder={routeType === "path" ? "hello-world" : "preview-demo"}
              />
            </label>

            <div className="form-hint">
              <strong>Preview URL</strong>
              <span>{routeType === "path" ? `http://localhost:8080/apps/${routeValue || "your-slug"}` : `http://${routeValue || "your-slug"}.127.0.0.1.sslip.io:8080`}</span>
            </div>

            <button className="submit-button" type="submit" disabled={createDeployment.isPending}>
              {createDeployment.isPending ? "Queueing..." : "Create deployment"}
            </button>

            {archiveFile && sourceType === "upload" ? (
              <p className="panel-copy">Selected archive: {archiveFile.name}</p>
            ) : null}

            {formError ? <p className="error-copy">{formError}</p> : null}
            {createDeployment.error ? (
              <p className="error-copy">{createDeployment.error.message}</p>
            ) : null}
          </form>
        </section>

        <section className="panel panel-list">
          <div className="panel-header">
            <p className="panel-kicker">Deployments</p>
            <h2>Current queue</h2>
            <p className="panel-copy">Every deployment keeps its route, image tag, and current state visible at a glance.</p>
          </div>

          <div className="deployment-list">
            {deployments.map((deployment) => (
              <button
                key={deployment.id}
                type="button"
                className={`deployment-card ${deployment.id === selectedDeploymentId ? "selected" : ""}`}
                onClick={() => {
                  void navigate({ search: { deploymentId: deployment.id } });
                }}
              >
                <div className="deployment-card-top">
                  <strong>{deployment.routeType === "path" ? `/apps/${deployment.routeValue}` : `${deployment.routeValue}.sslip.io`}</strong>
                  <StatusPill status={deployment.status} />
                </div>
                <p>{getDeploymentSourceLabel(deployment)}</p>
                <div className="deployment-route-type">{deployment.routeType === "path" ? "Path route" : "Host route"}</div>
                <div className="deployment-meta">
                  <span>{deployment.imageTag ?? "Awaiting build"}</span>
                  <a href={deployment.liveUrl} target="_blank" rel="noreferrer">
                    Open
                  </a>
                </div>
              </button>
            ))}

            {!deployments.length ? (
              <div className="empty-state">
                <strong>No deployments yet.</strong>
                <p>Submit a GitHub repo or upload a zip archive to queue the first build.</p>
              </div>
            ) : null}
          </div>
        </section>

        <section className="panel panel-logs">
          <div className="panel-header">
            <p className="panel-kicker">Live detail</p>
            <h2>{activeDeployment ? activeDeployment.id : "Select a deployment"}</h2>
            <p className="panel-copy">Status, route, and log output stay together so you can scan progress without hunting around the page.</p>
          </div>

          {activeDeployment ? (
            <div className="detail-stack">
              <div className="detail-grid">
                <div>
                  <span>Status</span>
                  <StatusPill status={activeDeployment.status} />
                </div>
                <div>
                  <span>Route</span>
                  <strong>{activeDeployment.routeType}:{activeDeployment.routeValue}</strong>
                </div>
                <div>
                  <span>Source</span>
                  <strong>{getDeploymentSourceLabel(activeDeployment)}</strong>
                </div>
                <div>
                  <span>Live URL</span>
                  <a href={liveUrl ?? activeDeployment.liveUrl} target="_blank" rel="noreferrer">
                    {liveUrl ?? activeDeployment.liveUrl}
                  </a>
                </div>
                <div>
                  <span>Image tag</span>
                  <strong>{activeDeployment.imageTag ?? "Pending"}</strong>
                </div>
              </div>

              {activeDeployment.failureReason ? (
                <p className="error-copy">Failure: {activeDeployment.failureReason}</p>
              ) : null}

              <div className="log-stage">
                <div className="log-stage-header">
                  <div>
                    <p className="log-stage-kicker">Build stream</p>
                    <h3>Live worker logs</h3>
                  </div>
                  <span>{logSummary.length} lines</span>
                </div>

                <div className="log-console">
                  {logSummary.length ? (
                    logSummary.map((entry) => (
                      <div key={entry.sequence} className={`log-row log-${entry.stream}`}>
                        <span>{entry.sequence.toString().padStart(4, "0")}</span>
                        <span>{entry.stream}</span>
                        <code>{entry.message}</code>
                      </div>
                    ))
                  ) : (
                    <div className="empty-state">
                      <strong>No logs yet.</strong>
                      <p>The selected deployment will stream persisted logs here once work starts.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <strong>No deployment selected.</strong>
              <p>Choose one from the list to inspect live logs and route details.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search) => dashboardSearchSchema.parse(search),
  component: DashboardPage
});

const PathRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/apps/$routeValue",
  component: PathDeploymentPage
});

const routeTree = rootRoute.addChildren([Route, PathRoute]);

const router = createRouter({
  routeTree
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function App() {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>
  );
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing root element.");
}

createRoot(rootElement).render(<App />);
