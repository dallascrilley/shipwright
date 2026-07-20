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
  mode: "issue" as const,
  issueUrl: "https://github.com/dallascrilley/example/issues/12",
  pullRequestUrl: "",
  skillId: "",
  presetId: "",
  verifyCommand: "bun test",
  publish: false,
  publishConfirmed: false,
  timeoutMinutes: 30,
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
        kind: "issue",
        request: {
          mode: "issue",
          issueUrl: request.issueUrl,
          pullRequestUrl: "",
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

  test("reconciles a completed durable receipt after restart", () => {
    const store = new MemoryOperatorRunStore([
      {
        runId: "run-1",
        status: "running",
        phase: "publish",
        kind: "issue",
        request: {
          mode: "issue",
          issueUrl: request.issueUrl,
          pullRequestUrl: "",
                    verifyCommand: request.verifyCommand,
          publish: true,
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
      () => ({
        ...completeReceipt,
        commitSha: "1234567890abcdef1234567890abcdef12345678",
        pullRequestUrl: "https://github.com/dallascrilley/example/pull/13",
      }),
    );

    expect(registry.get("run-1")).toMatchObject({
      status: "succeeded",
      phase: "complete",
      receipt: completeReceipt,
      updatedAt: "2026-07-19T00:02:00.000Z",
    });
    expect(store.load()[0]?.status).toBe("succeeded");
  });

  test("cancels an in-flight run and allows a subsequent start", async () => {
    let sawSignal = false;
    const registry = new OperatorRunRegistry(
      (_request, _runId, progress, signal) =>
        new Promise((_resolve, reject) => {
          progress({
            ...completeReceipt,
            phase: "agent",
            verification: {
              command: request.verifyCommand,
              exitCode: null,
              passed: false,
            },
          });
          const onAbort = () => {
            sawSignal = true;
            reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      (() => {
        let n = 0;
        return () => `run-${++n}`;
      })(),
    );

    registry.start(request);
    await flushMicrotasks();
    const cancelled = registry.cancel("run-1");
    expect(cancelled.status === "running" || cancelled.status === "failed").toBe(true);
    await flushMicrotasks();
    await flushMicrotasks();
    const failed = registry.get("run-1");
    expect(failed?.status).toBe("failed");
    expect(failed?.message).toMatch(/cancelled|aborted/i);
    expect(sawSignal).toBe(true);
    expect(() => registry.start(request)).not.toThrow();
  });

  test("lists durable runs newest first within the bound", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shipwright-runs-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "operator-runs.json");
    const store = new JsonFileOperatorRunStore(path);
    let n = 0;
    const first = new OperatorRunRegistry(
      async (_request, runId) => ({ ...completeReceipt, runId }),
      () => `run-${++n}`,
      store,
      (() => {
        let tick = 0;
        return () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)).toISOString();
      })(),
    );
    first.start(request);
    await flushMicrotasks();
    first.start(request);
    await flushMicrotasks();

    const second = new OperatorRunRegistry(
      () => new Promise(() => {}),
      () => "run-x",
      new JsonFileOperatorRunStore(path),
    );
    const listed = second.list(1);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.runId).toBe("run-2");
    expect(second.list(50).map((item) => item.runId)).toEqual(["run-2", "run-1"]);
  });



  test("records target summary and duration on success", async () => {
    let now = 1_000;
    const registry = new OperatorRunRegistry(
      async () => completeReceipt,
      () => "run-1",
      new MemoryOperatorRunStore(),
      () => new Date(now++ * 1000).toISOString(),
    );
    registry.start(request);
    await flushMicrotasks();
    const record = registry.get("run-1");
    expect(record?.target).toMatchObject({
      owner: "dallascrilley",
      repo: "example",
      number: 12,
      kind: "issue",
    });
    expect(record?.summary).toMatch(/verify passed/);
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
    expect(record?.request).not.toHaveProperty("skillPath");
  });

  test("sanitizes legacy skillPath on disk during load", () => {
    const directory = mkdtempSync(join(tmpdir(), "shipwright-runs-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "operator-runs.json");
    const store = new JsonFileOperatorRunStore(path);
    store.save([
      {
        runId: "legacy-1",
        status: "succeeded",
        phase: "complete",
        kind: "review",
        request: {
          mode: "review",
          issueUrl: "",
          pullRequestUrl: "https://github.com/dallascrilley/example/pull/9",
          skillPath: "/tmp/fix-review-findings/SKILL.md",
          verifyCommand: "bun test",
          publish: false,
          timeoutMinutes: 30,
        } as any,
        startedAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:00:01.000Z",
      } as any,
    ]);
    const registry = new OperatorRunRegistry(
      () => new Promise(() => {}),
      () => "run-x",
      new JsonFileOperatorRunStore(path),
    );
    const record = registry.get("legacy-1");
    expect(record?.request).not.toHaveProperty("skillPath");
    expect(record?.request.skillId).toBe("fix-review-findings");
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("skillPath");
    expect(raw).not.toContain("/tmp/fix-review-findings");
  });

  test("expands verify preset and supports fromRunId dry clone", async () => {
    const registry = new OperatorRunRegistry(
      async (input) => ({
        ...completeReceipt,
        verification: {
          command: input.verifyCommand,
          exitCode: 0,
          passed: true,
        },
      }),
      (() => {
        let n = 0;
        return () => `run-${++n}`;
      })(),
    );
    registry.start({
      ...request,
      presetId: "bun-test-typecheck",
      verifyCommand: "should-be-ignored",
    });
    await flushMicrotasks();
    expect(registry.get("run-1")?.request.verifyCommand).toBe(
      "bun test && bun run typecheck",
    );
    expect(registry.get("run-1")?.request.presetId).toBe("bun-test-typecheck");

    registry.start({
      fromRunId: "run-1",
      verifyCommand: "bun test",
      publish: false,
      publishConfirmed: false,
      timeoutMinutes: 30,
    } as any);
    await flushMicrotasks();
    const cloned = registry.get("run-2");
    expect(cloned?.request.issueUrl).toBe(request.issueUrl);
    expect(cloned?.request.verifyCommand).toBe("bun test && bun run typecheck");
    expect(cloned?.request).not.toHaveProperty("skillPath");
  });

  test("fromRunId publish requires confirmation at schema layer", async () => {
    const registry = new OperatorRunRegistry(
      async () => completeReceipt,
      (() => {
        let n = 0;
        return () => `run-${++n}`;
      })(),
    );
    registry.start(request);
    await flushMicrotasks();
    expect(() =>
      registry.start({
        fromRunId: "run-1",
        verifyCommand: "bun test",
        publish: true,
        publishConfirmed: true,
        timeoutMinutes: 30,
      } as any),
    ).not.toThrow();
    await flushMicrotasks();
  });

});
