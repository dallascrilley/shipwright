import { z } from "zod";
import type { RunExecution } from "../../src/pipeline/receipt";

export const RUN_PHASES = [
  "intake",
  "workspace",
  "agent",
  "verify",
  "policy",
  "publish",
  "complete",
] as const;

export type OperatorRunPhase = (typeof RUN_PHASES)[number];
export type OperatorRunStatus = "queued" | "running" | "succeeded" | "failed";

const ISSUE_URL_PATTERN =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/[1-9]\d*\/?$/;

export const operatorRunRequestSchema = z
  .object({
    issueUrl: z
      .string()
      .trim()
      .max(500)
      .refine((value) => ISSUE_URL_PATTERN.test(value), {
        message: "Enter a canonical GitHub issue URL.",
      }),
    verifyCommand: z.string().trim().min(1).max(500),
    publish: z.boolean().default(false),
    publishConfirmed: z.boolean().default(false),
    timeoutMinutes: z.number().int().min(1).max(60).default(20),
  })
  .superRefine((value, context) => {
    if (value.publish && !value.publishConfirmed) {
      context.addIssue({
        code: "custom",
        path: ["publishConfirmed"],
        message: "Publishing requires explicit confirmation.",
      });
    }
  });

export type OperatorRunRequest = z.infer<typeof operatorRunRequestSchema>;

export interface OperatorRunReceipt {
  runId: string;
  phase: OperatorRunPhase;
  issueUrl: string;
  execution: RunExecution;
  baseSha?: string;
  branch?: string;
  changedFiles: string[];
  verification: {
    command: string;
    exitCode: number | null;
    passed: boolean;
  };
  commitSha?: string;
  pullRequestUrl?: string;
  errorCode?: string;
}

export interface OperatorRunRecord {
  runId: string;
  status: OperatorRunStatus;
  phase: OperatorRunPhase;
  request: Omit<OperatorRunRequest, "publishConfirmed">;
  receipt?: OperatorRunReceipt;
  message?: string;
  startedAt: string;
  updatedAt: string;
}

export function isTerminalRun(status: OperatorRunStatus): boolean {
  return status === "succeeded" || status === "failed";
}

export function phaseIndex(phase: OperatorRunPhase): number {
  return RUN_PHASES.indexOf(phase);
}
