import { z } from "zod";
import type { RunExecution } from "../../src/pipeline/receipt";

export const RUN_PHASES = [
  "intake",
  "workspace",
  "agent",
  "verify",
  "policy",
  "publish",
  "threads",
  "complete",
] as const;

export type OperatorRunPhase = (typeof RUN_PHASES)[number];
export type OperatorRunStatus = "queued" | "running" | "succeeded" | "failed";
export type OperatorRunKind = "issue" | "review";

const ISSUE_URL_PATTERN =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/[1-9]\d*\/?$/;
const PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*\/?$/;

export const operatorRunRequestSchema = z
  .object({
    mode: z.enum(["issue", "review"]).default("issue"),
    issueUrl: z.string().trim().max(500).optional().default(""),
    pullRequestUrl: z.string().trim().max(500).optional().default(""),
    skillPath: z.string().trim().max(1000).optional().default(""),
    verifyCommand: z.string().trim().min(1).max(500),
    publish: z.boolean().default(false),
    publishConfirmed: z.boolean().default(false),
    timeoutMinutes: z.number().int().min(1).max(60).default(30),
  })
  .superRefine((value, context) => {
    if (value.publish && !value.publishConfirmed) {
      context.addIssue({
        code: "custom",
        path: ["publishConfirmed"],
        message: "Publishing requires explicit confirmation.",
      });
    }
    if (value.mode === "issue") {
      if (!ISSUE_URL_PATTERN.test(value.issueUrl)) {
        context.addIssue({
          code: "custom",
          path: ["issueUrl"],
          message: "Enter a canonical GitHub issue URL.",
        });
      }
    } else {
      if (!PULL_REQUEST_URL_PATTERN.test(value.pullRequestUrl)) {
        context.addIssue({
          code: "custom",
          path: ["pullRequestUrl"],
          message: "Enter a canonical GitHub pull request URL.",
        });
      }
      if (!value.skillPath) {
        context.addIssue({
          code: "custom",
          path: ["skillPath"],
          message: "Enter an absolute path to fix-review-findings/SKILL.md.",
        });
      }
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
    stdoutTail?: string;
    stderrTail?: string;
  };
  commitSha?: string;
  pullRequestUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  skillSha256?: string;
  threadResults?: Array<{
    threadId: string;
    outcome: string;
    replyUrl: string;
    resolved: boolean;
  }>;
}

export interface OperatorRunRecord {
  runId: string;
  status: OperatorRunStatus;
  phase: OperatorRunPhase;
  kind: OperatorRunKind;
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

export function targetUrl(request: Omit<OperatorRunRequest, "publishConfirmed">): string {
  return request.mode === "review" ? request.pullRequestUrl : request.issueUrl;
}
