import { describe, expect, test } from "vitest";

import type { RunReceipt } from "../../src/pipeline/receipt";
import { OperatorRunRegistry } from "./operator-runs";

const request = {
  issueUrl: "https://github.com/dallascrilley/example/issues/12",
  verifyCommand: "bun test",
  publish: false,
  publishConfirmed: false,
  timeoutMinutes: 20,
};

const completeReceipt: RunReceipt = {
  runId: "run-1",
  phase: "complete",
  issueUrl: request.issueUrl,
  execution: {
    runtime: "agentos",
    software: "pi",
    provider: "kimi",
    model: "kimi-for-coding",
  },
  changedFiles: ["src/example.ts"],
  verification: { command: request.verifyCommand, exitCode: 0, passed: true },
};

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("OperatorRunRegistry", () => {
  test("records progress and a successful result", async () => {
    const registry = new OperatorRunRegistry(
      async (_input, _runId, progress) => {
        progress({ ...completeReceipt, phase: "agent" });
        return completeReceipt;
      },
      () => "run-1",
    );

    expect(registry.start(request).status).toBe("queued");
    await flushMicrotasks();

    expect(registry.get("run-1")).toMatchObject({
      status: "succeeded",
      phase: "complete",
      receipt: completeReceipt,
    });
  });

  test("rejects a second active run", () => {
    const registry = new OperatorRunRegistry(
      () => new Promise(() => {}),
      () => "run-1",
    );

    registry.start(request);

    expect(() => registry.start(request)).toThrow("already active");
  });

  test("keeps the failed phase and redacts tokens from errors", async () => {
    const registry = new OperatorRunRegistry(
      async (_input, _runId, progress) => {
        progress({
          ...completeReceipt,
          phase: "verify",
          verification: {
            command: request.verifyCommand,
            exitCode: 1,
            passed: false,
          },
        });
        throw new Error("failed with github_pat_example00000000000000000000");
      },
      () => "run-1",
    );

    registry.start(request);
    await flushMicrotasks();

    expect(registry.get("run-1")?.phase).toBe("verify");
    expect(registry.get("run-1")?.message).toBe("failed with [REDACTED]");
  });
});
