import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  createPipelineDependencies,
  createReviewPipelineDependencies,
} from "../../src/cli/dependencies.js";
import { resolveShipwrightStateDirectory } from "../../src/config/state.js";
import type { RunReceipt } from "../../src/pipeline/receipt.js";
import type { ReviewRunReceipt } from "../../src/pipeline/review-receipt.js";
import { runReviewAgent } from "../../src/pipeline/review-run.js";
import { runShipwright } from "../../src/pipeline/run.js";
import { redactSecrets } from "../../src/pipeline/secret-safety";
import {
  buildRunSummary,
  isTerminalRun,
  parseOperatorTarget,
  targetUrl,
  appendOperatorRunEvent,
  summarizeOperatorRunEvent,
  type OperatorRunPhase,
  type OperatorRunReceipt,
  type OperatorRunRecord,
  type OperatorRunRequest,
  type OperatorRunEvent,
  type OperatorRunEventKind,
} from "../shared/operator-run";
import { resolveTarget } from "./resolve-target";
import {
  DEFAULT_REVIEW_SKILL_ID,
  resolveSkill,
  skillIdFromLegacyPath,
} from "./skills";
import { assertSafeVerifyCommand, resolveVerifyPreset } from "./verify-presets";

type StoredRequest = import("../shared/operator-run").OperatorStoredRequest;

type LegacyStoredRequest = StoredRequest & { skillPath?: string };

export type RunExecutor = (
  request: StoredRequest,
  runId: string,
  onProgress: (receipt: OperatorRunReceipt) => void,
  signal?: AbortSignal,
) => Promise<OperatorRunReceipt>;

export interface OperatorRunStore {
  load(): OperatorRunRecord[];
  save(records: readonly OperatorRunRecord[]): void;
}

export type RunReceiptLoader = (
  runId: string,
) => OperatorRunReceipt | undefined;

/** Deploy-level non-secret mode flag used by operator actions and execution. */
export function isOperatorDemoMode(): boolean {
  // guard:allow-env-credential — deploy-level non-secret mode flag
  return process.env.SHIPWRIGHT_UI_DEMO === "1";
}

export class MemoryOperatorRunStore implements OperatorRunStore {
  #records: OperatorRunRecord[];

  constructor(records: OperatorRunRecord[] = []) {
    this.#records = structuredClone(records);
  }

  load(): OperatorRunRecord[] {
    return structuredClone(this.#records);
  }

  save(records: readonly OperatorRunRecord[]): void {
    this.#records = structuredClone([...records]);
  }
}

export class JsonFileOperatorRunStore implements OperatorRunStore {
  constructor(private readonly path: string) {}

  load(): OperatorRunRecord[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(parsed)) {
        throw new Error("operator run state must be a JSON array");
      }
      return structuredClone(parsed as OperatorRunRecord[]);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw new Error(`could not load operator run state at ${this.path}`, {
        cause: error,
      });
    }
  }

  save(records: readonly OperatorRunRecord[]): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, this.path);
    chmodSync(this.path, 0o600);
  }
}

function sanitizeStoredRequest(
  raw: Partial<LegacyStoredRequest> | undefined,
  kindHint?: string,
): { request: StoredRequest; operatorHint?: string; mutated: boolean } {
  const mode =
    raw?.mode === "review" || kindHint === "review"
      ? ("review" as const)
      : ("issue" as const);
  let mutated = false;
  let operatorHint: string | undefined;
  const legacyPath =
    typeof raw?.skillPath === "string" ? raw.skillPath.trim() : "";
  let skillId = typeof raw?.skillId === "string" ? raw.skillId.trim() : "";
  if (legacyPath) {
    mutated = true;
    if (!skillId) {
      const mapped = skillIdFromLegacyPath(legacyPath);
      if (mapped) {
        skillId = mapped;
      } else if (mode === "review") {
        operatorHint =
          "re-run required: legacy skill path removed; select skillId";
      }
    }
  }
  if (mode === "review" && !skillId) {
    skillId = DEFAULT_REVIEW_SKILL_ID;
    mutated = true;
  }
  const request: StoredRequest = {
    mode,
    issueUrl: raw?.issueUrl ?? "",
    pullRequestUrl: raw?.pullRequestUrl ?? "",
    skillId,
    presetId: raw?.presetId ?? "",
    verifyCommand: raw?.verifyCommand ?? "",
    publish: Boolean(raw?.publish),
    timeoutMinutes: raw?.timeoutMinutes ?? 30,
  };
  // Never persist host skillPath on durable records.
  return { request, operatorHint, mutated };
}

function normalizeRecord(stored: OperatorRunRecord): {
  record: OperatorRunRecord;
  mutated: boolean;
} {
  const kind =
    stored.kind ?? (stored.request?.mode === "review" ? "review" : "issue");
  const {
    request,
    operatorHint,
    mutated: requestMutated,
  } = sanitizeStoredRequest(
    stored.request as Partial<LegacyStoredRequest> | undefined,
    kind,
  );
  const target =
    stored.target ?? parseOperatorTarget(targetUrl(request)) ?? undefined;
  const legacyRequest = stored.request as LegacyStoredRequest | undefined;
  const hadSkillPath = Boolean(legacyRequest?.skillPath?.trim());
  const mutated =
    requestMutated || hadSkillPath || (!stored.target && Boolean(target));
  const events = Array.isArray(stored.events) ? stored.events : [];
  const eventsMutated = !Array.isArray(stored.events);
  const record: OperatorRunRecord = {
    ...stored,
    kind: kind === "review" ? "review" : "issue",
    request,
    events,
    ...(target ? { target } : {}),
    ...(operatorHint && !stored.operatorHint ? { operatorHint } : {}),
  };
  return { record, mutated: mutated || eventsMutated };
}

export class OperatorRunRegistry {
  readonly #records = new Map<string, OperatorRunRecord>();
  readonly #controllers = new Map<string, AbortController>();

  constructor(
    private readonly execute: RunExecutor = executeOperatorPipeline,
    private readonly createRunId: () => string = () =>
      randomBytes(8).toString("hex"),
    private readonly store: OperatorRunStore = new MemoryOperatorRunStore(),
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly loadReceipt: RunReceiptLoader = () => undefined,
  ) {
    let reconciled = false;
    for (const stored of this.store.load()) {
      const { record, mutated } = normalizeRecord(structuredClone(stored));
      if (mutated) reconciled = true;
      if (!isTerminalRun(record.status)) {
        const durableReceipt = this.loadReceipt(record.runId);
        if (durableReceipt?.phase === "complete") {
          record.status = "succeeded";
          record.phase = "complete";
          record.receipt = structuredClone(durableReceipt);
          delete record.message;
          record.events = appendOperatorRunEvent(record.events, {
            at: this.now(),
            phase: record.phase,
            status: record.status,
            kind: "succeeded",
            summary: redactSecrets(
              summarizeOperatorRunEvent({
                kind: "succeeded",
                phase: record.phase,
                status: record.status,
                publish: record.request.publish,
                changedFileCount: record.receipt?.changedFiles?.length,
              }),
            ),
          });
        } else {
          record.status = "failed";
          record.message = "Run interrupted by service restart.";
          if (durableReceipt) {
            record.phase = durableReceipt.phase;
            record.receipt = structuredClone(durableReceipt);
          }
          record.events = appendOperatorRunEvent(record.events, {
            at: this.now(),
            phase: record.phase,
            status: record.status,
            kind: "interrupted",
            summary: redactSecrets(
              summarizeOperatorRunEvent({
                kind: "interrupted",
                phase: record.phase,
                status: record.status,
              }),
            ),
          });
        }
        record.updatedAt = this.now();
        record.finishedAt = record.finishedAt ?? this.now();
        record.summary = buildRunSummary(record);
        reconciled = true;
      }
      this.#records.set(record.runId, record);
    }
    if (reconciled) this.#persist();
  }

  async start(input: OperatorRunRequest): Promise<OperatorRunRecord> {
    const active = this.getLatest();
    if (active && !isTerminalRun(active.status)) {
      throw new Error(`Run ${active.runId} is already active.`);
    }

    const now = this.now();
    const runId = this.createRunId();
    const controller = new AbortController();

    let base: Partial<LegacyStoredRequest> = {
      mode: input.mode ?? "issue",
      issueUrl: input.issueUrl ?? "",
      pullRequestUrl: input.pullRequestUrl ?? "",
      skillId: input.skillId ?? "",
      presetId: input.presetId ?? "",
      verifyCommand: input.verifyCommand,
      publish: input.publish,
      timeoutMinutes: input.timeoutMinutes,
    };

    if (input.fromRunId?.trim()) {
      const prior = this.#records.get(input.fromRunId.trim());
      if (!prior) {
        throw new Error(`Unknown run ${input.fromRunId.trim()}.`);
      }
      if (prior.operatorHint?.includes("legacy skill path")) {
        throw new Error(
          "Cannot clone legacy review run; start a fresh review with skillId.",
        );
      }
      base = {
        ...prior.request,
        // never copy skillPath from legacy
        publish: input.publish,
        timeoutMinutes: input.timeoutMinutes || prior.request.timeoutMinutes,
      };
      if (input.presetId !== undefined) base.presetId = input.presetId;
      if (input.verifyCommand) base.verifyCommand = input.verifyCommand;
      if (input.skillId) base.skillId = input.skillId;
      // publishConfirmed enforced by schema when publish true
    }

    // Expand preset / validate raw command
    let verifyCommand = base.verifyCommand ?? "";
    let presetId = base.presetId ?? "";
    if (presetId) {
      const preset = resolveVerifyPreset(presetId);
      verifyCommand = preset.command;
      presetId = preset.id;
    } else {
      verifyCommand = assertSafeVerifyCommand(verifyCommand);
    }

    let skillId = base.skillId ?? "";
    const mode =
      base.mode === "review" ? ("review" as const) : ("issue" as const);
    if (mode === "review") {
      skillId = skillId || DEFAULT_REVIEW_SKILL_ID;
      // resolve now so bad skill fails before queue
      resolveSkill(skillId);
    } else {
      skillId = "";
    }

    const request: StoredRequest = {
      mode,
      issueUrl: base.issueUrl ?? "",
      pullRequestUrl: base.pullRequestUrl ?? "",
      skillId,
      presetId,
      verifyCommand,
      publish: Boolean(base.publish),
      timeoutMinutes: base.timeoutMinutes ?? 30,
    };

    const url = targetUrl(request);
    let target = parseOperatorTarget(url);
    if (target) {
      const resolved = await resolveTarget(
        url,
        {},
        { includeReviewThreads: false },
      );
      if (!resolved.allowed) {
        throw new Error(
          resolved.denyReason ?? "Target could not be authorized.",
        );
      }
      target = {
        ...target,
        ...(resolved.title ? { title: resolved.title } : {}),
      };
    }
    const record: OperatorRunRecord = {
      runId,
      status: "queued",
      phase: "intake",
      kind: mode === "review" ? "review" : "issue",
      request,
      events: [
        {
          at: now,
          phase: "intake",
          status: "queued",
          kind: "queued",
          summary: redactSecrets(
            summarizeOperatorRunEvent({
              kind: "queued",
              phase: "intake",
              status: "queued",
            }),
          ),
        },
      ],
      ...(target ? { target } : {}),
      startedAt: now,
      updatedAt: now,
    };
    this.#records.set(runId, record);
    this.#controllers.set(runId, controller);
    this.#persist();
    queueMicrotask(() => void this.#run(record, controller));
    return structuredClone(record);
  }

  get(runId: string): OperatorRunRecord | undefined {
    const record = this.#records.get(runId);
    return record ? structuredClone(record) : undefined;
  }

  getLatest(): OperatorRunRecord | undefined {
    const records = [...this.#records.values()];
    const record = records[records.length - 1];
    return record ? structuredClone(record) : undefined;
  }

  list(limit = 50): OperatorRunRecord[] {
    const bounded = Math.max(1, Math.min(limit, 200));
    return [...this.#records.values()]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, bounded)
      .map((record) => structuredClone(record));
  }

  cancel(runId: string): OperatorRunRecord {
    const record = this.#records.get(runId);
    if (!record) {
      throw new Error(`Unknown run ${runId}.`);
    }
    if (isTerminalRun(record.status)) {
      return structuredClone(record);
    }
    const controller = this.#controllers.get(runId);
    if (!controller) {
      throw new Error(`Run ${runId} is not cancellable.`);
    }
    controller.abort(new Error("Run cancelled by operator."));
    return structuredClone(this.#records.get(runId) ?? record);
  }

  async #run(
    initial: OperatorRunRecord,
    controller: AbortController,
  ): Promise<void> {
    this.#replace(initial.runId, {
      status: "running",
      phase: initial.phase,
      eventKind: "started",
    });
    try {
      const receipt = await this.execute(
        initial.request,
        initial.runId,
        (progress) => {
          this.#replace(initial.runId, {
            status: "running",
            phase: progress.phase,
            receipt: progress,
            eventKind: "phase",
          });
        },
        controller.signal,
      );
      this.#replace(initial.runId, {
        status: "succeeded",
        phase: "complete",
        receipt,
        message: undefined,
        eventKind: "succeeded",
      });
    } catch (error) {
      const current = this.#records.get(initial.runId);
      const message = redactSecrets(
        error instanceof Error ? error.message : String(error),
      );
      this.#replace(initial.runId, {
        status: "failed",
        phase: current?.phase ?? initial.phase,
        receipt: current?.receipt,
        message,
        eventKind: "failed",
      });
    } finally {
      this.#controllers.delete(initial.runId);
    }
  }

  #replace(
    runId: string,
    update: Partial<
      Pick<
        OperatorRunRecord,
        | "status"
        | "phase"
        | "receipt"
        | "message"
        | "finishedAt"
        | "operatorHint"
        | "target"
        | "summary"
        | "durationMs"
      >
    > & {
      eventKind?: OperatorRunEventKind;
    },
  ): OperatorRunRecord {
    const current = this.#records.get(runId);
    if (!current) {
      throw new Error(`Unknown run ${runId}.`);
    }
    const next: OperatorRunRecord = {
      ...current,
      ...update,
      events: current.events ?? [],
      ...(update.receipt ? { receipt: structuredClone(update.receipt) } : {}),
      updatedAt: this.now(),
    };
    delete (next as { eventKind?: OperatorRunEventKind }).eventKind;

    if (update.status && isTerminalRun(update.status)) {
      next.finishedAt = next.finishedAt ?? this.now();
      const started = Date.parse(next.startedAt);
      const finished = Date.parse(next.finishedAt);
      if (Number.isFinite(started) && Number.isFinite(finished)) {
        next.durationMs = Math.max(0, finished - started);
      }
      next.summary = buildRunSummary(next);
    }

    const eventKind = update.eventKind;
    if (eventKind) {
      let kind = eventKind;
      const message = next.message ?? next.receipt?.errorMessage ?? "";
      if (kind === "failed" && /cancelled by operator/i.test(message)) {
        kind = "cancelled";
      }
      const summary = redactSecrets(
        summarizeOperatorRunEvent({
          kind,
          phase: next.phase,
          status: next.status,
          publish: next.request.publish,
          changedFileCount: next.receipt?.changedFiles?.length,
        }),
      );
      next.events = appendOperatorRunEvent(next.events, {
        at: this.now(),
        phase: next.phase,
        status: next.status,
        kind,
        summary,
      });
    }

    this.#records.set(runId, next);
    this.#persist();
    return next;
  }

  #persist(): void {
    this.store.save([...this.#records.values()]);
  }
}

function toOperatorIssueReceipt(receipt: RunReceipt): OperatorRunReceipt {
  return {
    runId: receipt.runId,
    phase: receipt.phase,
    issueUrl: receipt.issueUrl,
    execution: receipt.execution,
    baseSha: receipt.baseSha,
    branch: receipt.branch,
    changedFiles: receipt.changedFiles,
    verification: receipt.verification,
    commitSha: receipt.commitSha,
    pullRequestUrl: receipt.pullRequestUrl,
    errorCode: receipt.errorCode,
    errorMessage: receipt.errorMessage,
  };
}

function toOperatorReviewReceipt(
  receipt: ReviewRunReceipt,
): OperatorRunReceipt {
  return {
    runId: receipt.runId,
    phase: receipt.phase,
    issueUrl: receipt.pullRequestUrl,
    execution: receipt.execution,
    baseSha: receipt.authorizedHeadSha,
    branch: receipt.headBranch,
    changedFiles: receipt.changedFiles,
    verification: receipt.verification,
    commitSha: receipt.commitSha,
    pullRequestUrl: receipt.pullRequestUrl,
    errorCode: receipt.errorCode,
    errorMessage: receipt.errorMessage,
    skillSha256: receipt.skill.sha256,
    threadResults: receipt.threadResults,
  };
}

export async function executeOperatorPipeline(
  request: StoredRequest,
  runId: string,
  onProgress: (receipt: OperatorRunReceipt) => void,
  signal?: AbortSignal,
): Promise<OperatorRunReceipt> {
  if (isOperatorDemoMode()) {
    return executeDemo(request, runId, onProgress, signal);
  }
  if (request.mode === "review") {
    const skill = resolveSkill(request.skillId || DEFAULT_REVIEW_SKILL_ID);
    const receipt = await runReviewAgent(
      {
        pullRequestUrl: request.pullRequestUrl,
        verifyCommand: request.verifyCommand,
        publish: request.publish,
        timeoutMinutes: request.timeoutMinutes,
      },
      createReviewPipelineDependencies(skill.path, {
        runId,
        signal,
        onProgress: (progress) => onProgress(toOperatorReviewReceipt(progress)),
      }),
    );
    return toOperatorReviewReceipt(receipt);
  }
  const receipt = await runShipwright(
    {
      issueUrl: request.issueUrl,
      verifyCommand: request.verifyCommand,
      publish: request.publish,
      timeoutMinutes: request.timeoutMinutes,
    },
    createPipelineDependencies({
      runId,
      signal,
      onProgress: (progress) => onProgress(toOperatorIssueReceipt(progress)),
    }),
  );
  return toOperatorIssueReceipt(receipt);
}

async function executeDemo(
  request: StoredRequest,
  runId: string,
  onProgress: (receipt: OperatorRunReceipt) => void,
  signal?: AbortSignal,
): Promise<OperatorRunReceipt> {
  if (request.publish) {
    throw new Error(
      "Demo supports dry-run only; start a live publish run outside demo.",
    );
  }
  const target =
    request.mode === "review" ? request.pullRequestUrl : request.issueUrl;
  const receipt: OperatorRunReceipt = {
    runId,
    phase: "intake",
    issueUrl: target,
    execution: {
      runtime: "demo",
      software: "demo",
      provider: "demo",
      model: "demo",
    },
    branch:
      request.mode === "review"
        ? `review/demo-${runId}`
        : `agent/demo-${runId}`,
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    changedFiles: [],
    verification: {
      command: request.verifyCommand,
      exitCode: null,
      passed: false,
    },
    pullRequestUrl:
      request.mode === "review" ? request.pullRequestUrl : undefined,
    skillSha256:
      request.mode === "review"
        ? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        : undefined,
    threadResults:
      request.mode === "review"
        ? [
            {
              threadId: "demo-thread",
              outcome: "fixed",
              replyUrl: "https://example.invalid/review_comment/1",
              resolved: true,
            },
          ]
        : undefined,
  };
  const phases: OperatorRunPhase[] =
    request.mode === "review"
      ? [
          "intake",
          "workspace",
          "agent",
          "verify",
          "policy",
          "threads",
          "complete",
        ]
      : ["intake", "workspace", "agent", "verify", "policy", "complete"];
  for (const phase of phases) {
    signal?.throwIfAborted();
    receipt.phase = phase;
    if (phase === "verify") {
      receipt.verification = {
        command: request.verifyCommand,
        exitCode: 0,
        passed: true,
      };
    }
    if (phase === "policy") {
      receipt.changedFiles = ["src/example.ts", "test/example.test.ts"];
    }
    onProgress(structuredClone(receipt));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, 120);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Run cancelled by operator."),
        );
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
  return receipt;
}

let registry: OperatorRunRegistry | undefined;

export function getOperatorRunRegistry(): OperatorRunRegistry {
  const stateDirectory = resolveShipwrightStateDirectory(); // guard:allow-env-credential — deploy-level state path
  registry ??= new OperatorRunRegistry(
    executeOperatorPipeline,
    () => randomBytes(8).toString("hex"),
    new JsonFileOperatorRunStore(join(stateDirectory, "operator-runs.json")),
    () => new Date().toISOString(),
    (runId) => loadDurableReceipt(stateDirectory, runId),
  );
  return registry;
}

function loadDurableReceipt(
  stateDirectory: string,
  runId: string,
): OperatorRunReceipt | undefined {
  if (!/^[0-9a-f]{16}$/.test(runId)) return undefined;
  for (const root of ["receipts", "review-receipts"] as const) {
    const path = join(stateDirectory, root, runId, "receipt.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("runId" in parsed) ||
        parsed.runId !== runId ||
        !("phase" in parsed) ||
        typeof parsed.phase !== "string"
      ) {
        continue;
      }
      if (root === "review-receipts") {
        return toOperatorReviewReceipt(parsed as ReviewRunReceipt);
      }
      return toOperatorIssueReceipt(parsed as RunReceipt);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw new Error(`could not load durable receipt for run ${runId}`, {
        cause: error,
      });
    }
  }
  return undefined;
}
