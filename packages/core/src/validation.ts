import { z } from "zod";

import { routeTypes } from "./types";

const githubRepoPattern =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function sanitizeRouteValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[._\s/]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

export const createGitDeploymentSchema = z
  .object({
    repoUrl: z
      .string()
      .trim()
      .url()
      .regex(
        githubRepoPattern,
        "Only public GitHub repository URLs are supported in this version."
      ),
    routeType: z.enum(routeTypes),
    routeValue: z.string().min(1)
  })
  .transform((value) => ({
    ...value,
    sourceType: "git" as const,
    routeValue: sanitizeRouteValue(value.routeValue)
  }))
  .superRefine((value, ctx) => {
    if (!slugPattern.test(value.routeValue)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["routeValue"],
        message:
          "Route values must be lowercase slugs with letters, numbers, and dashes only."
      });
    }
  });

export const createUploadDeploymentSchema = z
  .object({
    uploadFileName: z.string().trim().min(1, "Uploaded archive name is required."),
    uploadPath: z.string().trim().min(1, "Uploaded archive path is required."),
    routeType: z.enum(routeTypes),
    routeValue: z.string().min(1)
  })
  .transform((value) => ({
    ...value,
    sourceType: "upload" as const,
    routeValue: sanitizeRouteValue(value.routeValue)
  }))
  .superRefine((value, ctx) => {
    if (!slugPattern.test(value.routeValue)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["routeValue"],
        message:
          "Route values must be lowercase slugs with letters, numbers, and dashes only."
      });
    }
  });

export const createDeploymentSchema = createGitDeploymentSchema;

export type CreateDeploymentSchema = z.infer<typeof createDeploymentSchema>;
export type CreateGitDeploymentSchema = z.infer<typeof createGitDeploymentSchema>;
export type CreateUploadDeploymentSchema = z.infer<typeof createUploadDeploymentSchema>;
