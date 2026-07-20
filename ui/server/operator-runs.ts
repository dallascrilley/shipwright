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
import { redactSecrets, type RunReceipt } from "../../src/pipeline/receipt.js";
import type { ReviewRunReceipt } from "../../src/pipeline/review-receipt.js";
import { runReviewAgent } from "../../src/pipeline/review-run.js";
import { runShipwright } from "../../src/pipeline/run.js";
import type {
  OperatorRunPhase,
  OperatorRunReceipt,
  OperatorRunRecord,
  OperatorRunRequest,
} from "../shared/operator-run";
import {
  buildRunSummary,
  isTerminalRun,
  parseOperatorTarget,
  targetUrl,
} from "../shared/operator-run";

type StoredRequest = Omit<OperatorRunRequest, "publishConfirmed" | "fromRunId">;

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

export type RunReceiptLoader = (runId: string) => OperatorRunReceipt | undefined;

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

function normalizeRecord(stored: OperatorRunRecord): OperatorRunRecord {
  const mode = stored.request?.mode ?? stored.kind ?? "issue";
  const kind = stored.kind ?? (mode === "review" ? "review" : "issue");
  const request = {
    mode: mode === "review" ? ("review" as const) : ("issue" as const),
    issueUrl: stored.request?.issueUrl ?? "",
    pullRequestUrl: stored.request?.pullRequestUrl ?? "",
    skillPath: stored.request?.skillPath ?? "",
    skillId: stored.request?.skillId ?? "",
    presetId: stored.request?.presetId ?? "",
    verifyCommand: stored.request?.verifyCommand ?? "",
    publish: Boolean(stored.request?.publish),
    timeoutMinutes: stored.request?.timeoutMinutes ?? 30,
  };
  const target =
    stored.target ?? parseOperatorTarget(targetUrl(request)) ?? undefined;
  return {
    ...stored,
    kind,
    request,
    ...(target ? { target } : {}),
  };
}

export class OperatorRunRegistry {
  readonly #records = new Map<string, OperatorRunRecord>();
  readonly #controllers = new Map<string, AbortController>();

  constructor(
    private readonly execute: RunExecutor = executePipeline,
    private readonly createRunId: () => string = () =>
      randomBytes(8).toString("hex"),
    private readonly store: OperatorRunStore = new MemoryOperatorRunStore(),
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly loadReceipt: RunReceiptLoader = () => undefined,
  ) {
    let reconciled = false;
    for (const stored of this.store.load()) {
      const record = normalizeRecord(structuredClone(stored));
      if (!isTerminalRun(record.status)) {
        const durableReceipt = this.loadReceipt(record.runId);
        if (durableReceipt?.phase === "complete") {
          record.status = "succeeded";
          record.phase = "complete";
          record.receipt = structuredClone(durableReceipt);
          delete record.message;
        } else {
          record.status = "failed";
          record.message = "Run interrupted by service restart.";
          if (durableReceipt) {
            record.phase = durableReceipt.phase;
            record.receipt = structuredClone(durableReceipt);
          }
        }
        record.updatedAt = this.now();
        reconciled = true;
      }
      this.#records.set(record.runId, record);
    }
    if (reconciled) this.#persist();
  }

  start(input: OperatorRunRequest): OperatorRunRecord {
    const active = this.getLatest();
    if (active && !isTerminalRun(active.status)) {
      throw new Error(`Run ${active.runId} is already active.`);
    }

    const now = this.now();
    const runId = this.createRunId();
    const controller = new AbortController();
    const mode = input.mode ?? "issue";
    const request = {
      mode: mode === "review" ? ("review" as const) : ("issue" as const),
      issueUrl: input.issueUrl ?? "",
      pullRequestUrl: input.pullRequestUrl ?? "",
      skillPath: input.skillPath ?? "",
      skillId: input.skillId ?? "",
      presetId: input.presetId ?? "",
      verifyCommand: input.verifyCommand,
      publish: input.publish,
      timeoutMinutes: input.timeoutMinutes,
    };
    const target = parseOperatorTarget(targetUrl(request));
    const record: OperatorRunRecord = {
      runId,
      status: "queued",
      phase: "intake",
      kind: mode === "review" ? "review" : "issue",
      request,
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
    this.#replace(initial.runId, { status: "running" });
    try {
      const receipt = await this.execute(
        initial.request,
        initial.runId,
        (progress) => {
          this.#replace(initial.runId, {
            status: "running",
            phase: progress.phase,
            receipt: progress,
          });
        },
        controller.signal,
      );
      this.#replace(initial.runId, {
        status: "succeeded",
        phase: receipt.phase,
        receipt: structuredClone(receipt),
      });
    } catch (error) {
      const current = this.#records.get(initial.runId);
      const message = redactSecrets(
        error instanceof Error ? error.message : String(error),
      );
      const receipt = current?.receipt
        ? {
            ...structuredClone(current.receipt),
            errorMessage: current.receipt.errorMessage ?? message,
            errorCode:
              current.receipt.errorCode ??
              (controller.signal.aborted ? "cancelled" : undefined),
          }
        : current?.receipt;
      this.#replace(initial.runId, {
        status: "failed",
        phase: current?.phase ?? "intake",
        message,
        ...(receipt ? { receipt } : {}),
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
        | "summary"
        | "durationMs"
        | "finishedAt"
        | "operatorHint"
        | "target"
      >
    >,
  ): void {
    const current = this.#records.get(runId);
    if (!current) return;
    const next: OperatorRunRecord = {
      ...current,
      ...update,
      ...(update.receipt ? { receipt: structuredClone(update.receipt) } : {}),
      updatedAt: this.now(),
    };
    if (update.status && isTerminalRun(update.status)) {
      next.finishedAt = next.finishedAt ?? this.now();
      const started = Date.parse(next.startedAt);
      const finished = Date.parse(next.finishedAt);
      if (Number.isFinite(started) && Number.isFinite(finished)) {
        next.durationMs = Math.max(0, finished - started);
      }
      next.summary = buildRunSummary(next);
    }
    this.#records.set(runId, next);
    this.#persist();
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

function toOperatorReviewReceipt(receipt: ReviewRunReceipt): OperatorRunReceipt {
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

async function executePipeline(
  request: StoredRequest,
  runId: string,
  onProgress: (receipt: OperatorRunReceipt) => void,
  signal?: AbortSignal,
): Promise<OperatorRunReceipt> {
  if (process.env.SHIPWRIGHT_UI_DEMO === "1") {
    // guard:allow-env-credential — deploy-level non-secret mode flag
    return executeDemo(request, runId, onProgress, signal);
  }
  if (request.mode === "review") {
    const receipt = await runReviewAgent(
      {
        pullRequestUrl: request.pullRequestUrl,
        verifyCommand: request.verifyCommand,
        publish: request.publish,
        timeoutMinutes: request.timeoutMinutes,
      },
      createReviewPipelineDependencies(request.skillPath, {
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
    throw new Error("Demo mode supports dry runs only.");
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
      request.mode === "review" ? `review/demo-${runId}` : `agent/demo-${runId}`,
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
    executePipeline,
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
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw new Error(`could not load durable receipt for run ${runId}`, {
        cause: error,
      });
    }
  }
  return undefined;
}
