import { randomBytes } from "node:crypto";

import { createPipelineDependencies } from "../../src/cli/dependencies.js";
import { redactSecrets, type RunReceipt } from "../../src/pipeline/receipt.js";
import {
  runProgrammingAgent,
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

export class OperatorRunRegistry {
  readonly #records = new Map<string, OperatorRunRecord>();

  constructor(
    private readonly execute: RunExecutor = executePipeline,
    private readonly createRunId: () => string = () =>
      randomBytes(8).toString("hex"),
  ) {}

  start(input: OperatorRunRequest): OperatorRunRecord {
    const active = this.getLatest();
    if (active && !isTerminalRun(active.status)) {
      throw new Error(`Run ${active.runId} is already active.`);
    }

    const now = new Date().toISOString();
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
      updatedAt: new Date().toISOString(),
    });
  }
}

async function executePipeline(
  request: RunRequest,
  runId: string,
  onProgress: (receipt: RunReceipt) => void,
): Promise<RunReceipt> {
  if (process.env.AGENT_PROGRAMMING_UI_DEMO === "1") {
    return executeDemo(request, runId, onProgress);
  }
  return runProgrammingAgent(
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
  registry ??= new OperatorRunRegistry();
  return registry;
}
