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
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/([1-9]\d*)\/?$/;
const PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9]\d*)\/?$/;

export const operatorRunRequestSchema = z
  .object({
    mode: z.enum(["issue", "review"]).default("issue"),
    issueUrl: z.string().trim().max(500).optional().default(""),
    pullRequestUrl: z.string().trim().max(500).optional().default(""),
    skillId: z.string().trim().max(200).optional().default(""),
    presetId: z.string().trim().max(200).optional(),
    verifyCommand: z.string().trim().min(1).max(500),
    publish: z.boolean().default(false),
    publishConfirmed: z.boolean().default(false),
    timeoutMinutes: z.number().int().min(1).max(60).default(30),
    fromRunId: z.string().trim().max(64).optional(),
  })
  .superRefine((value, context) => {
    if (value.publish && !value.publishConfirmed) {
      context.addIssue({
        code: "custom",
        path: ["publishConfirmed"],
        message: "Publishing requires explicit confirmation.",
      });
    }
    if (value.fromRunId) {
      return;
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
      if (!value.skillId) {
        context.addIssue({
          code: "custom",
          path: ["skillId"],
          message: "Select a review skill (skillId).",
        });
      }
    }
  });

export type OperatorRunRequest = z.infer<typeof operatorRunRequestSchema>;

export interface OperatorRunTarget {
  kind: "issue" | "pull";
  owner: string;
  repo: string;
  number: number;
  url: string;
  title?: string;
}

export interface OperatorTargetPinned {
  headSha?: string;
  openThreadCount?: number;
}

/** Thin preflight snapshot (R7); not a broad GitHub mirror. */
export interface ResolveTargetResult {
  kind: "issue" | "pull";
  owner: string;
  repo: string;
  number: number;
  url: string;
  allowed: boolean;
  title?: string;
  denyReason?: string;
  pinned?: OperatorTargetPinned;
}

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

export type OperatorStoredRequest = Omit<
  OperatorRunRequest,
  "publishConfirmed" | "fromRunId"
>;

export interface OperatorRunRecord {
  runId: string;
  status: OperatorRunStatus;
  phase: OperatorRunPhase;
  kind: OperatorRunKind;
  request: OperatorStoredRequest;
  receipt?: OperatorRunReceipt;
  message?: string;
  target?: OperatorRunTarget;
  summary?: string;
  durationMs?: number;
  finishedAt?: string;
  operatorHint?: string;
  startedAt: string;
  updatedAt: string;
}

export type OperatorNextActionType =
  | "cancel"
  | "start_publish_run"
  | "open_url"
  | "retry_dry_run"
  | "edit_verify_retry"
  | "fix_target"
  | "none";

export interface OperatorNextAction {
  type: OperatorNextActionType;
  label: string;
  /** Caveat for CTAs that start a new publish run (not in-place promote). */
  caveat?: string;
  url?: string;
  runId?: string;
}

export interface OperatorNextActionView {
  headline: string;
  primary: OperatorNextAction;
  secondary: OperatorNextAction[];
}

export function isTerminalRun(status: OperatorRunStatus): boolean {
  return status === "succeeded" || status === "failed";
}

export function phaseIndex(phase: OperatorRunPhase): number {
  return RUN_PHASES.indexOf(phase);
}

export function targetUrl(
  request: Pick<
    OperatorRunRequest,
    "mode" | "issueUrl" | "pullRequestUrl"
  >,
): string {
  return request.mode === "review" ? request.pullRequestUrl : request.issueUrl;
}

export function parseOperatorTarget(
  url: string,
): OperatorRunTarget | undefined {
  const issue = url.trim().match(ISSUE_URL_PATTERN);
  if (issue) {
    return {
      kind: "issue",
      owner: issue[1]!,
      repo: issue[2]!,
      number: Number(issue[3]),
      url: url.trim().replace(/\/$/, ""),
    };
  }
  const pull = url.trim().match(PULL_REQUEST_URL_PATTERN);
  if (pull) {
    return {
      kind: "pull",
      owner: pull[1]!,
      repo: pull[2]!,
      number: Number(pull[3]),
      url: url.trim().replace(/\/$/, ""),
    };
  }
  return undefined;
}

export function detectRunModeFromUrl(
  url: string,
): "issue" | "review" | undefined {
  const target = parseOperatorTarget(url);
  if (!target) return undefined;
  return target.kind === "pull" ? "review" : "issue";
}

export function buildRunSummary(record: OperatorRunRecord): string {
  const receipt = record.receipt;
  if (record.status === "failed") {
    if (receipt?.errorCode === "cancelled" || /cancelled/i.test(record.message ?? "")) {
      return "cancelled";
    }
    if (receipt?.verification && receipt.verification.exitCode !== null && !receipt.verification.passed) {
      return `verify failed (exit ${receipt.verification.exitCode})`;
    }
    if (receipt?.errorCode) return receipt.errorCode;
    if (record.message) return truncateSummary(record.message);
    return "failed";
  }
  if (record.status === "succeeded") {
    const files = receipt?.changedFiles?.length ?? 0;
    if (receipt?.pullRequestUrl && record.request.publish) {
      return `published · ${files} file${files === 1 ? "" : "s"}`;
    }
    if (receipt?.verification?.passed) {
      return `verify passed · ${files} file${files === 1 ? "" : "s"}`;
    }
    return "succeeded";
  }
  if (record.status === "queued") return "queued";
  return record.phase;
}

function truncateSummary(value: string, max = 120): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

const PUBLISH_RERUN_CAVEAT =
  "Starts a new publish run with the same inputs. The agent reruns and may produce a different diff. Prior pinned head SHA is shown when known; the run re-authorizes and re-verifies. Does not promote the dry-run workspace.";

/**
 * Pure next-action matrix for the operator console.
 * Dry-run success never implies in-place promote (pipeline publish is start-time only).
 */
export function resolveOperatorNextAction(
  record: OperatorRunRecord,
): OperatorNextActionView {
  const secondary: OperatorNextAction[] = [];
  const target = record.target?.url ?? targetUrl(record.request);

  if (!isTerminalRun(record.status)) {
    return {
      headline:
        record.status === "queued"
          ? "Queued"
          : `Running · ${record.phase}`,
      primary: {
        type: "cancel",
        label: "Cancel run",
        runId: record.runId,
      },
      secondary,
    };
  }

  if (record.status === "succeeded") {
    if (record.request.publish && record.receipt?.pullRequestUrl) {
      secondary.push({
        type: "retry_dry_run",
        label: "Retry dry-run",
        runId: record.runId,
      });
      return {
        headline: "Pull request published",
        primary: {
          type: "open_url",
          label: "Open pull request",
          url: record.receipt.pullRequestUrl,
        },
        secondary,
      };
    }

    const pinned = record.receipt?.baseSha
      ? ` Prior head ${record.receipt.baseSha.slice(0, 7)}.`
      : "";
    secondary.push({
      type: "retry_dry_run",
      label: "Retry dry-run",
      runId: record.runId,
    });
    if (target) {
      secondary.push({
        type: "open_url",
        label: record.kind === "review" ? "Open pull request" : "Open issue",
        url: target,
      });
    }
    return {
      headline: "Dry-run succeeded",
      primary: {
        type: "start_publish_run",
        label: "Start publish run (same inputs)",
        caveat: `${PUBLISH_RERUN_CAVEAT}${pinned}`,
        runId: record.runId,
      },
      secondary,
    };
  }

  // failed
  const code = record.receipt?.errorCode;
  const message = record.receipt?.errorMessage ?? record.message ?? "Run failed";
  const verifyFailed =
    record.phase === "verify" ||
    (record.receipt?.verification &&
      record.receipt.verification.exitCode !== null &&
      !record.receipt.verification.passed);

  if (code === "cancelled") {
    return {
      headline: "Cancelled",
      primary: {
        type: "retry_dry_run",
        label: "Retry dry-run",
        runId: record.runId,
      },
      secondary: target
        ? [{ type: "open_url", label: "Open target", url: target }]
        : [],
    };
  }

  if (
    record.phase === "intake" ||
    code === "unauthorized" ||
    code === "not_allowlisted" ||
    /allowlist|unauthorized|canonical/i.test(message)
  ) {
    return {
      headline: "Target could not be authorized",
      primary: { type: "fix_target", label: "Fix target" },
      secondary: [
        {
          type: "retry_dry_run",
          label: "Retry dry-run",
          runId: record.runId,
        },
      ],
    };
  }

  if (verifyFailed) {
    return {
      headline: `Verification failed${
        record.receipt?.verification?.exitCode != null
          ? ` (exit ${record.receipt.verification.exitCode})`
          : ""
      }`,
      primary: {
        type: "edit_verify_retry",
        label: "Edit verify & retry dry-run",
        runId: record.runId,
      },
      secondary: target
        ? [{ type: "open_url", label: "Open target", url: target }]
        : [],
    };
  }

  return {
    headline: truncateSummary(message, 80),
    primary: {
      type: "retry_dry_run",
      label: "Retry dry-run",
      runId: record.runId,
    },
    secondary: target
      ? [{ type: "open_url", label: "Open target", url: target }]
      : [],
  };
}
