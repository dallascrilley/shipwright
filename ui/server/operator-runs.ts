import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { createPipelineDependencies } from "../../src/cli/dependencies.js";
import { redactSecrets, type RunReceipt } from "../../src/pipeline/receipt.js";
import {
  runShipwright,
  type RunRequest,
} from "../../src/pipeline/run.js";
import type {
  OperatorRunPhase,
  OperatorRunRecord,
  OperatorRunRequest,
} from "../shared/operator-run";
import { isTerminalRun } from "../shared/operator-run";

export type RunExecutor = (
  request: RunRequest,
  runId: string,
  onProgress: (receipt: RunReceipt) => void,
) => Promise<RunReceipt>;

export interface OperatorRunStore {
  load(): OperatorRunRecord[];
  save(records: readonly OperatorRunRecord[]): void;
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

export class OperatorRunRegistry {
  readonly #records = new Map<string, OperatorRunRecord>();

  constructor(
    private readonly execute: RunExecutor = executePipeline,
    private readonly createRunId: () => string = () =>
      randomBytes(8).toString("hex"),
    private readonly store: OperatorRunStore = new MemoryOperatorRunStore(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    let reconciled = false;
    for (const stored of this.store.load()) {
      const record = structuredClone(stored);
      if (!isTerminalRun(record.status)) {
        record.status = "failed";
        record.message = "Run interrupted by service restart.";
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
    const record: OperatorRunRecord = {
      runId,
      status: "queued",
      phase: "intake",
      request: {
        issueUrl: input.issueUrl,
        verifyCommand: input.verifyCommand,
        publish: input.publish,
        timeoutMinutes: input.timeoutMinutes,
      },
      startedAt: now,
      updatedAt: now,
    };
    this.#records.set(runId, record);
    this.#persist();
    queueMicrotask(() => void this.#run(record));
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

  async #run(initial: OperatorRunRecord): Promise<void> {
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
      );
      this.#replace(initial.runId, {
        status: "succeeded",
        phase: receipt.phase,
        receipt: structuredClone(receipt),
      });
    } catch (error) {
      const current = this.#records.get(initial.runId);
      this.#replace(initial.runId, {
        status: "failed",
        phase: current?.phase ?? "intake",
        message: redactSecrets(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
  }

  #replace(
    runId: string,
    update: Partial<
      Pick<OperatorRunRecord, "status" | "phase" | "receipt" | "message">
    >,
  ): void {
    const current = this.#records.get(runId);
    if (!current) return;
    this.#records.set(runId, {
      ...current,
      ...update,
      ...(update.receipt ? { receipt: structuredClone(update.receipt) } : {}),
      updatedAt: this.now(),
    });
    this.#persist();
  }

  #persist(): void {
    this.store.save([...this.#records.values()]);
  }
}

async function executePipeline(
  request: RunRequest,
  runId: string,
  onProgress: (receipt: RunReceipt) => void,
): Promise<RunReceipt> {
  if (process.env.SHIPWRIGHT_UI_DEMO === "1") { // guard:allow-env-credential — deploy-level non-secret mode flag
    return executeDemo(request, runId, onProgress);
  }
  return runShipwright(
    request,
    createPipelineDependencies({ runId, onProgress }),
  );
}

async function executeDemo(
  request: RunRequest,
  runId: string,
  onProgress: (receipt: RunReceipt) => void,
): Promise<RunReceipt> {
  if (request.publish) {
    throw new Error("Demo mode supports dry runs only.");
  }
  const receipt: RunReceipt = {
    runId,
    phase: "intake",
    issueUrl: request.issueUrl,
    execution: {
      runtime: "demo",
      software: "demo",
      provider: "demo",
      model: "demo",
    },
    branch: `agent/demo-${runId}`,
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    changedFiles: [],
    verification: {
      command: request.verifyCommand,
      exitCode: null,
      passed: false,
    },
  };
  const phases: OperatorRunPhase[] = [
    "intake",
    "workspace",
    "agent",
    "verify",
    "policy",
    "complete",
  ];
  for (const phase of phases) {
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
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return receipt;
}

let registry: OperatorRunRegistry | undefined;

export function getOperatorRunRegistry(): OperatorRunRegistry {
  const stateDirectory =
    process.env.SHIPWRIGHT_STATE_DIR?.trim() || ".artifacts/shipwright"; // guard:allow-env-credential — deploy-level state path
  registry ??= new OperatorRunRegistry(
    executePipeline,
    () => randomBytes(8).toString("hex"),
    new JsonFileOperatorRunStore(join(stateDirectory, "operator-runs.json")),
  );
  return registry;
}
