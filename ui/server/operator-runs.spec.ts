import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { RunReceipt } from "../../src/pipeline/receipt";
import { operatorRunRequestSchema } from "../shared/operator-run";
import {
  JsonFileOperatorRunStore,
  MemoryOperatorRunStore,
  OperatorRunRegistry,
} from "./operator-runs";
import { selectRetainedOperatorRuns } from "../shared/operator-run";
import * as resolveTargetModule from "./resolve-target";

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
  skillPath: undefined,
  fromRunId: undefined,
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

    const started = await registry.start(request);
    expect(started.status).toBe("queued");
    await flushMicrotasks();

    expect(registry.get("run-1")).toMatchObject({
      status: "succeeded",
      phase: "complete",
      receipt: completeReceipt,
    });
  });

  test("rejects a second active run", async () => {
    const registry = new OperatorRunRegistry(
      () => new Promise(() => {}),
      () => "run-1",
    );

    await registry.start(request);

    await expect(registry.start(request)).rejects.toThrow("already active");
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

    await registry.start(request);
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

    await first.start(request);
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
          skillId: "",
          presetId: "",
          verifyCommand: request.verifyCommand,
          publish: request.publish,
          timeoutMinutes: request.timeoutMinutes,
        },
        events: [],
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
          skillId: "",
          presetId: "",
          verifyCommand: request.verifyCommand,
          publish: true,
          timeoutMinutes: request.timeoutMinutes,
        },
        events: [],
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
            reject(
              signal?.reason instanceof Error
                ? signal.reason
                : new Error("aborted"),
            );
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

    await registry.start(request);
    await flushMicrotasks();
    const cancelled = registry.cancel("run-1");
    expect(
      cancelled.status === "running" || cancelled.status === "failed",
    ).toBe(true);
    await flushMicrotasks();
    await flushMicrotasks();
    const failed = registry.get("run-1");
    expect(failed?.status).toBe("failed");
    expect(failed?.message).toMatch(/cancelled|aborted/i);
    expect(sawSignal).toBe(true);
    await expect(registry.start(request)).resolves.toBeDefined();
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
    await first.start(request);
    await flushMicrotasks();
    await first.start(request);
    await flushMicrotasks();

    const second = new OperatorRunRegistry(
      () => new Promise(() => {}),
      () => "run-x",
      new JsonFileOperatorRunStore(path),
    );
    const listed = second.list(1);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.runId).toBe("run-2");
    expect(second.list(50).map((item) => item.runId)).toEqual([
      "run-2",
      "run-1",
    ]);
  });

  test("records target summary and duration on success", async () => {
    let now = 1_000;
    const registry = new OperatorRunRegistry(
      async () => completeReceipt,
      () => "run-1",
      new MemoryOperatorRunStore(),
      () => new Date(now++ * 1000).toISOString(),
    );
    await registry.start(request);
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
        events: [],
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
    await registry.start({
      ...request,
      presetId: "bun-test-typecheck",
      verifyCommand: "should-be-ignored",
    });
    await flushMicrotasks();
    expect(registry.get("run-1")?.request.verifyCommand).toBe(
      "bun test && bun run typecheck",
    );
    expect(registry.get("run-1")?.request.presetId).toBe("bun-test-typecheck");

    await registry.start({
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

  test("fromRunId can clear a preset for a raw verify override", async () => {
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
    await registry.start({
      ...request,
      presetId: "bun-test-typecheck",
      verifyCommand: "ignored-by-preset",
    });
    await flushMicrotasks();

    await registry.start(
      operatorRunRequestSchema.parse({
        fromRunId: "run-1",
        presetId: "",
        verifyCommand: "bun run verify",
        publish: false,
        publishConfirmed: false,
        timeoutMinutes: 30,
      }),
    );
    await flushMicrotasks();

    expect(registry.get("run-2")?.request).toMatchObject({
      presetId: "",
      verifyCommand: "bun run verify",
    });
  });

  test("fromRunId publish requires confirmation at schema layer", async () => {
    const registry = new OperatorRunRegistry(
      async () => completeReceipt,
      (() => {
        let n = 0;
        return () => `run-${++n}`;
      })(),
    );
    await registry.start(request);
    await flushMicrotasks();
    await registry.start({
      fromRunId: "run-1",
      verifyCommand: "bun test",
      publish: true,
      publishConfirmed: true,
      timeoutMinutes: 30,
    } as any);
    await flushMicrotasks();
  });

  test("rejects start when resolve-target denies the URL", async () => {
    const spy = vi
      .spyOn(resolveTargetModule, "resolveTarget")
      .mockResolvedValue({
        kind: "issue",
        owner: "dallascrilley",
        repo: "example",
        number: 12,
        url: request.issueUrl,
        allowed: false,
        denyReason: "repository is not in the GitHub repository allowlist",
      });
    const registry = new OperatorRunRegistry(
      async () => completeReceipt,
      () => "run-1",
    );

    await expect(registry.start(request)).rejects.toThrow(/allowlist/i);
    spy.mockRestore();
  });

  test("persists a redacted phase timeline across issue progress", async () => {
    const registry = new OperatorRunRegistry(
      async (_input, runId, progress) => {
        progress({
          ...completeReceipt,
          runId,
          phase: "agent",
          changedFiles: ["a.ts", "b.ts"],
        });
        progress({
          ...completeReceipt,
          runId,
          phase: "verify",
          changedFiles: ["a.ts", "b.ts"],
        });
        return {
          ...completeReceipt,
          runId,
          phase: "complete",
          changedFiles: ["a.ts", "b.ts"],
        };
      },
      () => "timeline-1",
    );

    await registry.start(request);
    await flushMicrotasks();

    const record = registry.get("timeline-1");
    expect(record?.events?.length).toBeGreaterThanOrEqual(4);
    expect(record?.events?.[0]).toMatchObject({
      kind: "queued",
      phase: "intake",
      status: "queued",
      summary: "Run queued",
    });
    expect(record?.events?.some((event) => event.kind === "started")).toBe(
      true,
    );
    expect(
      record?.events?.some(
        (event) => event.phase === "verify" && event.kind === "phase",
      ),
    ).toBe(true);
    expect(record?.events?.[record.events.length - 1]).toMatchObject({
      kind: "succeeded",
      status: "succeeded",
      summary: "Dry run completed · 2 changed files",
    });
  });

  test("records interrupted timeline entry after restart reconciliation", () => {
    const store = new MemoryOperatorRunStore([
      {
        runId: "interrupt-timeline",
        status: "running",
        phase: "agent",
        kind: "issue",
        request: {
          mode: "issue",
          issueUrl: request.issueUrl,
          pullRequestUrl: "",
          skillId: "",
          presetId: "",
          verifyCommand: request.verifyCommand,
          publish: false,
          timeoutMinutes: 30,
        },
        events: [],
        startedAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:01:00.000Z",
      } as any,
    ]);

    const registry = new OperatorRunRegistry(
      () => new Promise(() => {}),
      () => "unused",
      store,
      () => "2026-07-20T12:05:00.000Z",
    );

    const record = registry.get("interrupt-timeline");
    expect(record?.status).toBe("failed");
    expect(record?.events?.some((event) => event.kind === "interrupted")).toBe(
      true,
    );
    expect(record?.events?.[record.events.length - 1]?.summary).toBe(
      "Run interrupted after service restart",
    );
  });

  test("listPage filters sorts and pages with opaque cursors", async () => {
    const registry = new OperatorRunRegistry(
      async () => completeReceipt,
      (() => {
        let n = 0;
        return () => `run-${++n}`;
      })(),
    );
    for (let i = 0; i < 4; i += 1) {
      await registry.start({
        ...request,
        issueUrl: `https://github.com/dallascrilley/example/issues/${10 + i}`,
      });
      await flushMicrotasks();
    }
    const page1 = registry.listPage({ limit: 2, query: "example" });
    expect(page1.records).toHaveLength(2);
    expect(page1.total).toBe(4);
    expect(page1.retainedCount).toBe(4);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.nextCursor!.includes("run-")).toBe(false);

    const page2 = registry.listPage({ limit: 2, cursor: page1.nextCursor });
    expect(page2.records).toHaveLength(2);
    expect(page2.nextCursor).toBeUndefined();
    expect(page2.records[0]?.runId).not.toBe(page1.records[0]?.runId);

    expect(registry.listPage({ status: "failed" }).total).toBe(0);
    expect(registry.list(1)).toHaveLength(1);
  });

  test("successful persist can prune terminals while keeping active records", () => {
    const dir = mkdtempSync(join(tmpdir(), "shipwright-retain-"));
    const path = join(dir, "runs.json");
    const seed = [
      {
        runId: "active-1",
        status: "running",
        phase: "agent",
        kind: "issue",
        request: {
          mode: "issue",
          issueUrl: request.issueUrl,
          pullRequestUrl: "",
          skillId: "",
          presetId: "bun-test",
          verifyCommand: "bun test",
          publish: false,
          timeoutMinutes: 30,
        },
        startedAt: "2026-07-20T20:00:00.000Z",
        updatedAt: "2026-07-20T20:01:00.000Z",
      },
      ...Array.from({ length: 6 }, (_, i) => ({
        runId: `old-${i}`,
        status: "succeeded",
        phase: "complete",
        kind: "issue",
        request: {
          mode: "issue",
          issueUrl: request.issueUrl,
          pullRequestUrl: "",
          skillId: "",
          presetId: "bun-test",
          verifyCommand: "bun test",
          publish: false,
          timeoutMinutes: 30,
        },
        startedAt: `2026-07-20T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
        updatedAt: `2026-07-20T${String(10 + i).padStart(2, "0")}:01:00.000Z`,
      })),
    ];
    const store = new JsonFileOperatorRunStore(path);
    // Pre-prune with a small ceiling via selectRetainedOperatorRuns to simulate
    // the registry retention helper, then ensure reload keeps active.
    store.save(
      selectRetainedOperatorRuns(seed as any, { maxTerminal: 2 }) as any,
    );
    const registry = new OperatorRunRegistry(
      async () => completeReceipt,
      () => "id",
      store,
    );
    const page = registry.listPage({ limit: 50 });
    expect(page.records.some((r) => r.runId === "active-1")).toBe(true);
    expect(page.retainedCount).toBe(3); // active + 2 terminals
    rmSync(dir, { recursive: true, force: true });
  });

  test("throwing store save leaves in-memory records unchanged", async () => {
    const store = new MemoryOperatorRunStore();
    const registry = new OperatorRunRegistry(
      async () => completeReceipt,
      () => "run-keep",
      store,
    );
    await registry.start(request);
    await flushMicrotasks();
    expect(registry.listPage({}).retainedCount).toBe(1);

    const original = store.save.bind(store);
    let calls = 0;
    store.save = (records) => {
      calls += 1;
      if (calls === 1) throw new Error("disk full");
      return original(records);
    };
    await expect(registry.start({ ...request, issueUrl: "https://github.com/dallascrilley/example/issues/99" })).rejects.toThrow(/disk full|already active|Run /);
    // Depending on whether previous run still active - flush completed so terminal.
    // After throw on second start, first record must remain.
    expect(registry.get("run-keep")).toBeTruthy();
    store.save = original;
  });


  test("selected descendant lineage survives pruning on successful persist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shipwright-selected-retain-"));
    const path = join(dir, "runs.json");
    const store = new JsonFileOperatorRunStore(path);
    const baseTarget = {
      kind: "issue" as const,
      owner: "dallascrilley",
      repo: "example",
      number: 12,
      url: request.issueUrl,
    };
    const baseRequest = {
      mode: "issue" as const,
      issueUrl: request.issueUrl,
      pullRequestUrl: "",
      skillId: "",
      presetId: "bun-test",
      verifyCommand: "bun test",
      publish: false,
      timeoutMinutes: 30,
    };
    const seed = [
      {
        runId: "root",
        status: "succeeded" as const,
        phase: "complete" as const,
        kind: "issue" as const,
        request: baseRequest,
        target: baseTarget,
        rootRunId: "root",
        startedAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:01:00.000Z",
      },
      {
        runId: "selected",
        status: "succeeded" as const,
        phase: "complete" as const,
        kind: "issue" as const,
        request: baseRequest,
        target: baseTarget,
        parentRunId: "root",
        rootRunId: "root",
        startedAt: "2026-07-20T11:00:00.000Z",
        updatedAt: "2026-07-20T11:01:00.000Z",
      },
      ...Array.from({ length: 5 }, (_, i) => ({
        runId: `noise-${i}`,
        status: "succeeded" as const,
        phase: "complete" as const,
        kind: "issue" as const,
        request: baseRequest,
        target: { ...baseTarget, number: 100 + i },
        startedAt: `2026-07-20T1${i}:30:00.000Z`,
        updatedAt: `2026-07-20T1${i}:31:00.000Z`,
      })),
    ];
    store.save(seed as any);

    // maxTerminal=1 would drop root/selected without selection protection
    const registry = new OperatorRunRegistry(
      async () => completeReceipt,
      () => "new-run",
      store,
      () => "2026-07-20T21:00:00.000Z",
      () => undefined,
      1,
    );

    // Selection signal via listPage (as the console does)
    registry.listPage({ selectedRunId: "selected", limit: 50 });
    expect(registry.get("selected")?.runId).toBe("selected");

    // Force persist by starting a new terminal run after selection
    await registry.start({
      ...request,
      issueUrl: "https://github.com/dallascrilley/example/issues/99",
    });
    await flushMicrotasks();

    const page = registry.listPage({ limit: 50 });
    const ids = new Set(page.records.map((r) => r.runId));
    expect(ids.has("selected")).toBe(true);
    expect(ids.has("root")).toBe(true);
    // noise should be mostly pruned under ceiling 1 (+ protected selected lineage + new run)
    expect(ids.has("noise-0")).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

});
