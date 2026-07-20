import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { RunReceipt } from "../../src/pipeline/receipt";
import {
  JsonFileOperatorRunStore,
  MemoryOperatorRunStore,
  OperatorRunRegistry,
} from "./operator-runs";

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

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

  test("persists completed records for a new registry process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shipwright-runs-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "operator-runs.json");
    const store = new JsonFileOperatorRunStore(path);
    const first = new OperatorRunRegistry(
      async () => completeReceipt,
      () => "run-1",
      store,
    );

    first.start(request);
    await flushMicrotasks();

    const second = new OperatorRunRegistry(
      () => new Promise(() => {}),
      () => "run-2",
      new JsonFileOperatorRunStore(path),
    );
    expect(second.get("run-1")).toMatchObject({
      status: "succeeded",
      phase: "complete",
      receipt: completeReceipt,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("reconciles an active record as interrupted after restart", () => {
    const store = new MemoryOperatorRunStore([
      {
        runId: "run-1",
        status: "running",
        phase: "agent",
        request: {
          issueUrl: request.issueUrl,
          verifyCommand: request.verifyCommand,
          publish: request.publish,
          timeoutMinutes: request.timeoutMinutes,
        },
        startedAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:01:00.000Z",
      },
    ]);

    const registry = new OperatorRunRegistry(
      () => new Promise(() => {}),
      () => "run-2",
      store,
      () => "2026-07-19T00:02:00.000Z",
    );

    expect(registry.get("run-1")).toMatchObject({
      status: "failed",
      phase: "agent",
      message: "Run interrupted by service restart.",
      updatedAt: "2026-07-19T00:02:00.000Z",
    });
    expect(store.load()[0]?.status).toBe("failed");
  });
});
