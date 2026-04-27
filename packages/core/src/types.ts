export const deploymentStatuses = [
  "pending",
  "building",
  "deploying",
  "running",
  "failed"
] as const;

export const routeTypes = [
  "path",
  "host"
] as const;

export const sourceTypes = [
  "git",
  "upload"
] as const;

export const logStreams = [
  "stdout",
  "stderr",
  "system"
] as const;

export const workerJobStatuses = [
  "pending",
  "processing",
  "completed",
  "failed"
] as const;

export type DeploymentStatus = (typeof deploymentStatuses)[number];
export type RouteType = (typeof routeTypes)[number];
export type SourceType = (typeof sourceTypes)[number];
export type LogStream = (typeof logStreams)[number];
export type WorkerJobStatus = (typeof workerJobStatuses)[number];

export interface DeploymentRecord {
  id: string;
  sourceType: SourceType;
  repoUrl: string | null;
  uploadFileName: string | null;
  uploadPath: string | null;
  status: DeploymentStatus;
  imageTag: string | null;
  routeType: RouteType;
  routeValue: string;
  containerName: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DeploymentView {
  id: string;
  sourceType: SourceType;
  repoUrl: string | null;
  uploadFileName: string | null;
  status: DeploymentStatus;
  imageTag: string | null;
  routeType: RouteType;
  routeValue: string;
  containerName: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  liveUrl: string;
}

export interface DeploymentLogRecord {
  deploymentId: string;
  sequence: number;
  stream: LogStream;
  message: string;
  createdAt: string;
}

export interface WorkerJobRecord {
  id: string;
  deploymentId: string;
  status: WorkerJobStatus;
  lockedAt: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimedJob {
  job: WorkerJobRecord;
  deployment: DeploymentRecord;
}

export interface CreateDeploymentBaseInput {
  routeType: RouteType;
  routeValue: string;
}

export interface CreateGitDeploymentInput extends CreateDeploymentBaseInput {
  sourceType: "git";
  repoUrl: string;
}

export interface CreateUploadDeploymentInput extends CreateDeploymentBaseInput {
  sourceType: "upload";
  uploadFileName: string;
  uploadPath: string;
}

export type CreateDeploymentInput = CreateGitDeploymentInput | CreateUploadDeploymentInput;

export interface DeploymentRouteTarget {
  id: string;
  routeType: RouteType;
  routeValue: string;
  containerName: string;
}

export interface UpdateDeploymentPatch {
  status?: DeploymentStatus;
  imageTag?: string | null;
  containerName?: string | null;
  failureReason?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}
