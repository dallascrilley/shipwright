import { z } from "zod";

import type { RunExecution } from "../../src/pipeline/receipt";
import { redactSecrets } from "../../src/pipeline/secret-safety";

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

export const OPERATOR_RUN_EVENT_KINDS = [
  "queued",
  "started",
  "phase",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type OperatorRunEventKind = (typeof OPERATOR_RUN_EVENT_KINDS)[number];

/** Server-authored, redacted lifecycle entry. Never browser-supplied. */
export interface OperatorRunEvent {
  at: string;
  phase: OperatorRunPhase;
  status: OperatorRunStatus;
  kind: OperatorRunEventKind;
  summary: string;
}

export const OPERATOR_RUN_EVENT_LIMIT = 32;

const PHASE_EVENT_SUMMARY: Record<OperatorRunPhase, string> = {
  intake: "Intake started",
  workspace: "Workspace preparation started",
  agent: "Agent execution started",
  verify: "Verification started",
  policy: "Policy checks started",
  publish: "Publish started",
  threads: "Thread replies started",
  complete: "Run completed",
};

export function summarizeOperatorRunEvent(input: {
  kind: OperatorRunEventKind;
  phase: OperatorRunPhase;
  status: OperatorRunStatus;
  publish?: boolean;
  changedFileCount?: number;
}): string {
  switch (input.kind) {
    case "queued":
      return "Run queued";
    case "started":
      return "Run started";
    case "succeeded": {
      const bits = [input.publish ? "Publish completed" : "Dry run completed"];
      if (
        typeof input.changedFileCount === "number" &&
        Number.isFinite(input.changedFileCount)
      ) {
        const n = Math.max(0, Math.floor(input.changedFileCount));
        bits.push(n === 1 ? "1 changed file" : `${n} changed files`);
      }
      return bits.join(" · ");
    }
    case "failed":
      return "Run failed";
    case "cancelled":
      return "Run cancelled by operator";
    case "interrupted":
      return "Run interrupted after service restart";
    case "phase":
    default:
      return PHASE_EVENT_SUMMARY[input.phase] ?? `Phase ${input.phase}`;
  }
}

/** Append one redacted event; dedupe adjacent phase/status; cap at limit. */
export function appendOperatorRunEvent(
  events: OperatorRunEvent[] | undefined,
  event: OperatorRunEvent,
  options?: { limit?: number },
): OperatorRunEvent[] {
  const limit = options?.limit ?? OPERATOR_RUN_EVENT_LIMIT;
  const current = Array.isArray(events) ? events.slice() : [];
  const prev = current[current.length - 1];
  if (prev && prev.phase === event.phase && prev.status === event.status) {
    return current.slice(-limit);
  }
  current.push(event);
  if (current.length <= limit) return current;
  return current.slice(current.length - limit);
}

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
    /** Advanced path: treat verifyCommand as raw; not persisted on durable records. */
    useRawVerify: z.boolean().optional(),
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
  "publishConfirmed" | "fromRunId" | "useRawVerify"
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
  /** Present only for Phase 2 control-plane executions; P0 runs stay standalone. */
  agentId?: string;
  agentRevision?: number;
  /** Server-authored redacted lifecycle timeline; legacy records normalize to []. */
  events: OperatorRunEvent[];
  summary?: string;
  durationMs?: number;
  finishedAt?: string;
  operatorHint?: string;
  /** Immediate predecessor when this run was started via fromRunId. */
  parentRunId?: string;
  /**
   * Root of the intentional retry/publish chain.
   * Fresh runs set this to their own runId. Legacy records may omit it.
   */
  rootRunId?: string;
  /** Non-secret explanation of how verify preset/command was chosen. */
  verifySelectionReason?: string;
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

export const MAX_RETAINED_TERMINAL_RUNS = 500;
export const DEFAULT_RUN_LIST_LIMIT = 50;
export const MAX_RUN_LIST_LIMIT = 100;

export const operatorRunListRequestSchema = z
  .object({
    query: z.string().trim().max(200).optional().default(""),
    status: z
      .enum(["queued", "running", "succeeded", "failed", "active", "terminal"])
      .optional(),
    mode: z.enum(["issue", "review"]).optional(),
    /** Inclusive lower bound on startedAt (ISO-8601). */
    from: z.string().trim().max(40).optional(),
    /** Inclusive upper bound on startedAt (ISO-8601). */
    to: z.string().trim().max(40).optional(),
    /** Opaque cursor from a prior page response. */
    cursor: z.string().trim().max(200).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_RUN_LIST_LIMIT)
      .optional()
      .default(DEFAULT_RUN_LIST_LIMIT),
    /**
     * Operator-selected run id. list-shipwright-runs / get-shipwright-run
     * remember this as a retention root so selected descendants and their
     * lineage ancestors survive terminal pruning.
     */
    selectedRunId: z.string().trim().max(64).optional(),
  })
  .superRefine((value, context) => {
    if (value.from && Number.isNaN(Date.parse(value.from))) {
      context.addIssue({
        code: "custom",
        path: ["from"],
        message: "from must be a valid ISO-8601 timestamp.",
      });
    }
    if (value.to && Number.isNaN(Date.parse(value.to))) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "to must be a valid ISO-8601 timestamp.",
      });
    }
  });

export type OperatorRunListRequest = z.infer<
  typeof operatorRunListRequestSchema
>;

export interface OperatorRunListResponse {
  records: OperatorRunRecord[];
  total: number;
  nextCursor?: string;
  retainedCount: number;
  earliestRetainedAt?: string;
  demoMode?: boolean;
}

/** Safe searchable text only — no receipt tails, errors, skill bodies, or raw URLs. */
export function buildOperatorRunSearchText(record: OperatorRunRecord): string {
  // Intentionally excludes runId (prefix-matched separately), raw URLs,
  // receipt tails, error bodies, and skill content.
  const parts: string[] = [record.summary ?? ""];
  if (record.target) {
    parts.push(
      record.target.owner,
      record.target.repo,
      String(record.target.number),
      record.target.title ?? "",
    );
  }
  return parts.join(" ").toLowerCase();
}

export function matchesOperatorRunListFilters(
  record: OperatorRunRecord,
  filters: Partial<
    Pick<OperatorRunListRequest, "query" | "status" | "mode" | "from" | "to">
  >,
): boolean {
  const query = (filters.query ?? "").trim().toLowerCase();
  if (query) {
    const haystack = buildOperatorRunSearchText(record);
    const runId = record.runId.toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    const ok = tokens.every((token) => {
      if (haystack.includes(token)) return true;
      // run id: prefix only (never substring inside the id)
      return runId.startsWith(token);
    });
    if (!ok) return false;
  }

  if (filters.status === "active" && isTerminalRun(record.status)) return false;
  if (filters.status === "terminal" && !isTerminalRun(record.status))
    return false;
  if (
    filters.status &&
    filters.status !== "active" &&
    filters.status !== "terminal" &&
    record.status !== filters.status
  ) {
    return false;
  }

  if (
    filters.mode &&
    record.kind !== filters.mode &&
    record.request.mode !== filters.mode
  ) {
    return false;
  }

  if (filters.from) {
    const fromMs = Date.parse(filters.from);
    const startedMs = Date.parse(record.startedAt);
    if (
      !Number.isNaN(fromMs) &&
      !Number.isNaN(startedMs) &&
      startedMs < fromMs
    ) {
      return false;
    }
  }
  if (filters.to) {
    const toMs = Date.parse(filters.to);
    const startedMs = Date.parse(record.startedAt);
    if (!Number.isNaN(toMs) && !Number.isNaN(startedMs) && startedMs > toMs) {
      return false;
    }
  }
  return true;
}

export function compareRunsNewestFirst(
  left: OperatorRunRecord,
  right: OperatorRunRecord,
): number {
  const byStarted = right.startedAt.localeCompare(left.startedAt);
  if (byStarted !== 0) return byStarted;
  return right.runId.localeCompare(left.runId);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const bytes = base64ToBytes(padded + pad);
  return new TextDecoder().decode(bytes);
}

/** Opaque cursor — clients must not parse structure. */
export function encodeRunListCursor(record: OperatorRunRecord): string {
  return toBase64Url(
    JSON.stringify({ startedAt: record.startedAt, runId: record.runId }),
  );
}

export function decodeRunListCursor(
  cursor: string | undefined,
): { startedAt: string; runId: string } | undefined {
  const raw = (cursor ?? "").trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(fromBase64Url(raw)) as {
      startedAt?: unknown;
      runId?: unknown;
    };
    if (
      typeof parsed.startedAt !== "string" ||
      typeof parsed.runId !== "string" ||
      !parsed.startedAt ||
      !parsed.runId
    ) {
      return undefined;
    }
    return { startedAt: parsed.startedAt, runId: parsed.runId };
  } catch {
    return undefined;
  }
}

export function paginateOperatorRuns(
  records: readonly OperatorRunRecord[],
  request: OperatorRunListRequest,
): Pick<OperatorRunListResponse, "records" | "total" | "nextCursor"> {
  const filtered = [...records]
    .filter((record) => matchesOperatorRunListFilters(record, request))
    .sort(compareRunsNewestFirst);

  const limit = request.limit ?? DEFAULT_RUN_LIST_LIMIT;
  const cursor = decodeRunListCursor(request.cursor);

  const isAfterCursor = (record: OperatorRunRecord): boolean => {
    if (!cursor) return true;
    const startedCmp = record.startedAt.localeCompare(cursor.startedAt);
    // newest-first: "after cursor" means older than cursor item
    if (startedCmp < 0) return true;
    if (startedCmp > 0) return false;
    return record.runId.localeCompare(cursor.runId) < 0;
  };

  const offsetRecords = cursor ? filtered.filter(isAfterCursor) : filtered;
  const page = offsetRecords.slice(0, limit);
  const hasMore = offsetRecords.length > limit;

  return {
    records: page,
    total: filtered.length,
    ...(hasMore && page.length > 0
      ? { nextCursor: encodeRunListCursor(page[page.length - 1]!) }
      : {}),
  };
}

/**
 * Compute the retained set under the terminal ceiling.
 * Never drops active/nonterminal records. Keeps lineage ancestors of
 * protected records (active/nonterminal + optional selectedRunId) and walks
 * parent/root lineage for each. Pure: does not mutate inputs.
 */
export function selectRetainedOperatorRuns(
  records: readonly OperatorRunRecord[],
  options: { selectedRunId?: string; maxTerminal?: number } = {},
): OperatorRunRecord[] {
  const maxTerminal = options.maxTerminal ?? MAX_RETAINED_TERMINAL_RUNS;
  const byId = new Map(records.map((record) => [record.runId, record]));
  const protectedIds = new Set<string>();

  for (const record of records) {
    if (!isTerminalRun(record.status)) protectedIds.add(record.runId);
  }
  if (options.selectedRunId && byId.has(options.selectedRunId)) {
    protectedIds.add(options.selectedRunId);
  }

  // Walk parents for every protected record.
  for (const id of [...protectedIds]) {
    let cursor = byId.get(id);
    const seen = new Set<string>();
    while (cursor?.parentRunId) {
      const parentId = cursor.parentRunId;
      if (seen.has(parentId)) break;
      seen.add(parentId);
      protectedIds.add(parentId);
      cursor = byId.get(parentId);
      if (!cursor) break;
    }
    if (cursor?.rootRunId) protectedIds.add(cursor.rootRunId);
  }

  const terminals = records
    .filter(
      (record) =>
        isTerminalRun(record.status) && !protectedIds.has(record.runId),
    )
    .sort(compareRunsNewestFirst);

  const keptTerminalIds = new Set(
    terminals.slice(0, maxTerminal).map((record) => record.runId),
  );

  return records.filter(
    (record) =>
      protectedIds.has(record.runId) || keptTerminalIds.has(record.runId),
  );
}

export function isTerminalRun(status: OperatorRunStatus): boolean {
  return status === "succeeded" || status === "failed";
}

export function phaseIndex(phase: OperatorRunPhase): number {
  return RUN_PHASES.indexOf(phase);
}

export function targetUrl(
  request: Pick<OperatorRunRequest, "mode" | "issueUrl" | "pullRequestUrl">,
): string {
  return request.mode === "review" ? request.pullRequestUrl : request.issueUrl;
}

export interface OperatorPublishConfirmation {
  sourceRunId?: string;
  target: string;
  verifyCommand: string;
  mode: OperatorRunKind;
  skillId: string;
  pinnedSha?: string;
}


export const OPERATOR_CHANGE_EVIDENCE_FILE_LIMIT = 10;

export interface OperatorChangeEvidence {
  sourceRunId: string;
  target: string;
  mode: OperatorRunKind;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  publish: boolean;
  verification: {
    command: string;
    passed: boolean;
    exitCode: number | null;
  };
  changedFileCount: number;
  changedFiles: string[];
  changedFilesTruncated: boolean;
  baseSha?: string;
  commitSha?: string;
  branch?: string;
  pullRequestUrl?: string;
}

function basenamePreservingPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").trim();
  if (!normalized) return "";
  const isAbsolute =
    normalized.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    normalized.startsWith("//");
  const redacted = redactSecrets(normalized).trim();
  if (!redacted) return "";
  const parts = redacted
    .replace(/^[A-Za-z]:\//, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..");
  if (parts.length === 0) return "";
  // Absolute host paths must not leak directory layout; keep basename only.
  if (isAbsolute) {
    return parts[parts.length - 1]!;
  }
  return parts.join("/");
}

/**
 * Pure pre-publish evidence projection from a durable prior run.
 * Returns null when no receipt exists so intake-only publish never invents evidence.
 */
export function buildOperatorChangeEvidence(
  record: OperatorRunRecord | null | undefined,
): OperatorChangeEvidence | null {
  if (!record?.receipt) return null;
  const receipt = record.receipt;
  const rawFiles = Array.isArray(receipt.changedFiles) ? receipt.changedFiles : [];
  const normalized = rawFiles
    .map((file) => basenamePreservingPath(String(file)))
    .filter(Boolean);
  const changedFiles = normalized.slice(0, OPERATOR_CHANGE_EVIDENCE_FILE_LIMIT);
  const verificationCommand = redactSecrets(receipt.verification.command);
  return {
    sourceRunId: record.runId,
    target: record.target?.url ?? targetUrl(record.request),
    mode: record.kind,
    startedAt: record.startedAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
    publish: Boolean(record.request.publish),
    verification: {
      command: verificationCommand,
      passed: Boolean(receipt.verification.passed),
      exitCode: receipt.verification.exitCode,
    },
    changedFileCount: normalized.length,
    changedFiles,
    changedFilesTruncated: normalized.length > changedFiles.length,
    ...(receipt.baseSha ? { baseSha: receipt.baseSha } : {}),
    ...(receipt.commitSha ? { commitSha: receipt.commitSha } : {}),
    ...(receipt.branch ? { branch: redactSecrets(receipt.branch) } : {}),
    ...(receipt.pullRequestUrl
      ? { pullRequestUrl: redactSecrets(receipt.pullRequestUrl) }
      : {}),
  };
}

export function resolveOperatorPublishConfirmation(
  publishSource: OperatorRunRecord | null,
  form: Pick<
    OperatorRunRequest,
    "mode" | "issueUrl" | "pullRequestUrl" | "skillId" | "verifyCommand"
  >,
): OperatorPublishConfirmation {
  const request = publishSource?.request ?? form;
  const baseSha = publishSource?.receipt?.baseSha;
  return {
    ...(publishSource ? { sourceRunId: publishSource.runId } : {}),
    target: targetUrl(request),
    verifyCommand: request.verifyCommand,
    mode: request.mode,
    skillId: request.skillId ?? "",
    ...(baseSha ? { pinnedSha: baseSha.slice(0, 7) } : {}),
  };
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


export const RUN_INTERRUPTED_BY_RESTART_MESSAGE =
  "Run interrupted by service restart.";

export function isRunInterruptedByRestart(record: OperatorRunRecord): boolean {
  const message = record.message ?? "";
  return message.includes(RUN_INTERRUPTED_BY_RESTART_MESSAGE);
}

/**
 * Static, non-secret recovery hints. Classify only from stable status/phase/
 * errorCode/restart markers — never from free-form pipeline or model text.
 */
export function resolveOperatorHint(
  record: OperatorRunRecord,
): string | undefined {
  if (record.operatorHint) return record.operatorHint;
  if (isRunInterruptedByRestart(record)) {
    return "The host restarted while this run was active. Start a new dry-run with the same inputs; prior sandbox work is not resumed.";
  }
  if (record.receipt?.errorCode === "cancelled") {
    return "Cancelled by operator. Retry starts a fresh run.";
  }
  if (
    record.phase === "intake" ||
    record.receipt?.errorCode === "unauthorized" ||
    record.receipt?.errorCode === "not_allowlisted"
  ) {
    return "Fix the target URL or allowlist entry, then retry.";
  }
  if (
    record.receipt?.verification &&
    record.receipt.verification.exitCode !== null &&
    !record.receipt.verification.passed
  ) {
    return "Verification failed. Edit the command or choose another preset, then retry.";
  }
  return undefined;
}

/**
 * Deterministic recovery selection for refresh/restart.
 * Priority: active → restart-interrupted → failed recoverable → latest terminal.
 * Side-effect free; never starts, cancels, or publishes.
 */
export const MAX_LINEAGE_DEPTH = 32;

export interface OperatorRunLineageLink {
  runId: string;
  parentRunId?: string;
  rootRunId?: string;
  missing?: boolean;
}

export interface OperatorRunLineage {
  runId: string;
  parentRunId?: string;
  rootRunId?: string;
  /** Ancestor chain from immediate parent up to root (or until missing/cycle). */
  ancestors: OperatorRunLineageLink[];
  /** True when a referenced parent/root is absent from the lookup set. */
  truncated: boolean;
}

/**
 * Pure lineage projection. Does not invent links from URL/title similarity.
 * Tolerates missing/pruned ancestors and guards against cycles/depth blowups.
 */
export function resolveOperatorRunLineage(
  record: OperatorRunRecord,
  recordsById: ReadonlyMap<string, OperatorRunRecord> | ReadonlyArray<OperatorRunRecord>,
): OperatorRunLineage {
  let lookup: ReadonlyMap<string, OperatorRunRecord>;
  if (recordsById instanceof Map) {
    lookup = recordsById;
  } else {
    const entries = recordsById as ReadonlyArray<OperatorRunRecord>;
    lookup = new Map(entries.map((entry) => [entry.runId, entry]));
  }

  const ancestors: OperatorRunLineageLink[] = [];
  const seen = new Set<string>([record.runId]);
  let truncated = false;
  let cursor = record.parentRunId?.trim() || undefined;

  while (cursor) {
    if (seen.has(cursor) || ancestors.length >= MAX_LINEAGE_DEPTH) {
      truncated = true;
      break;
    }
    seen.add(cursor);
    const ancestor = lookup.get(cursor);
    if (!ancestor) {
      ancestors.push({ runId: cursor, missing: true });
      truncated = true;
      break;
    }
    ancestors.push({
      runId: ancestor.runId,
      ...(ancestor.parentRunId ? { parentRunId: ancestor.parentRunId } : {}),
      ...(ancestor.rootRunId ? { rootRunId: ancestor.rootRunId } : {}),
    });
    cursor = ancestor.parentRunId?.trim() || undefined;
  }

  const rootRunId =
    record.rootRunId?.trim() ||
    ancestors.find((entry) => !entry.missing && entry.rootRunId)?.rootRunId ||
    (ancestors.length === 0 ? record.runId : ancestors[ancestors.length - 1]?.runId);

  if (record.rootRunId?.trim()) {
    const declaredRoot = record.rootRunId.trim();
    if (!lookup.has(declaredRoot) && declaredRoot !== record.runId) {
      truncated = true;
    }
  }

  return {
    runId: record.runId,
    ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
    ...(rootRunId ? { rootRunId } : {}),
    ancestors,
    truncated,
  };
}

/** Client-side intake hydration from a historical record. Never starts a run. */
export function hydrateIntakeFromRecord(record: OperatorRunRecord): {
  targetInput: string;
  mode: OperatorRunKind;
  skillId: string;
  presetId: string;
  verifyCommand: string;
  useRawVerify: boolean;
  timeoutMinutes: number;
  advancedOpen: boolean;
} {
  const presetId = (record.request.presetId ?? "").trim();
  const useRawVerify = !presetId;
  return {
    targetInput: targetUrl(record.request),
    mode: record.request.mode,
    skillId: record.request.skillId || "fix-review-findings",
    presetId,
    verifyCommand: record.request.verifyCommand,
    useRawVerify,
    timeoutMinutes: record.request.timeoutMinutes,
    advancedOpen: record.request.mode === "review" || useRawVerify,
  };
}

/**
 * Deterministic recovery selection for refresh/restart.
 * Priority: active → restart-interrupted → failed recoverable → latest terminal.
 * Side-effect free; never starts, cancels, or publishes.
 */
export function resolveRecoverySelection(
  records: OperatorRunRecord[],
): OperatorRunRecord | undefined {
  if (records.length === 0) return undefined;
  const sorted = [...records].sort((left, right) => {
    const byStarted = right.startedAt.localeCompare(left.startedAt);
    if (byStarted !== 0) return byStarted;
    const byUpdated = right.updatedAt.localeCompare(left.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    // Stable final tie-break so equal timestamps do not depend on input order.
    return right.runId.localeCompare(left.runId);
  });
  const active = sorted.find((record) => !isTerminalRun(record.status));
  if (active) return active;
  const interrupted = sorted.find((record) => isRunInterruptedByRestart(record));
  if (interrupted) return interrupted;
  const failed = sorted.find((record) => record.status === "failed");
  if (failed) return failed;
  return sorted[0];
}

export function buildRunSummary(record: OperatorRunRecord): string {
  const receipt = record.receipt;
  if (record.status === "failed") {
    if (isRunInterruptedByRestart(record)) {
      return "interrupted by restart";
    }
    if (
      receipt?.errorCode === "cancelled" ||
      /cancelled/i.test(record.message ?? "")
    ) {
      return "cancelled";
    }
    if (
      receipt?.verification &&
      receipt.verification.exitCode !== null &&
      !receipt.verification.passed
    ) {
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
        record.status === "queued" ? "Queued" : `Running · ${record.phase}`,
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
  if (isRunInterruptedByRestart(record)) {
    return {
      headline: "Interrupted by service restart",
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

  const code = record.receipt?.errorCode;
  const message =
    record.receipt?.errorMessage ?? record.message ?? "Run failed";
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
