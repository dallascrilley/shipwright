import { describe, expect, test } from "vitest";

import {
  appendOperatorRunEvent,
  buildOperatorChangeEvidence,
  buildRunSummary,
  decodeRunListCursor,
  detectRunModeFromUrl,
  OPERATOR_RUN_EVENT_LIMIT,
  encodeRunListCursor,
  matchesOperatorRunListFilters,
  operatorRunListRequestSchema,
  OPERATOR_CHANGE_EVIDENCE_FILE_LIMIT,
  isRunInterruptedByRestart,
  operatorRunRequestSchema,
  paginateOperatorRuns,
  parseOperatorTarget,
  resolveOperatorHint,
  resolveOperatorNextAction,
  resolveOperatorPublishConfirmation,
  summarizeOperatorRunEvent,
  type OperatorRunEvent,
  selectRetainedOperatorRuns,
  resolveRecoverySelection,
  RUN_INTERRUPTED_BY_RESTART_MESSAGE,
  type OperatorRunRecord,,
  hydrateIntakeFromRecord,
  resolveOperatorRunLineage
} from "./operator-run";

const validInput = {
  mode: "issue" as const,
  issueUrl: "https://github.com/dallascrilley/example/issues/12",
  verifyCommand: "bun test",
  timeoutMinutes: 30,
};

function baseRecord(
  overrides: Partial<OperatorRunRecord> = {},
): OperatorRunRecord {
  return {
    runId: "run-1",
    status: "succeeded",
    phase: "complete",
    kind: "issue",
    request: {
      mode: "issue",
      issueUrl: "https://github.com/dallascrilley/example/issues/12",
      pullRequestUrl: "",
      skillId: "",
      presetId: "",
      verifyCommand: "bun test",
      publish: false,
      timeoutMinutes: 30,
    },
    target: {
      kind: "issue",
      owner: "dallascrilley",
      repo: "example",
      number: 12,
      url: "https://github.com/dallascrilley/example/issues/12",
    },
    events: [],
    startedAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:02:00.000Z",
    ...overrides,
  };
}

describe("operatorRunRequestSchema", () => {
  test("defaults to a dry run", () => {
    const result = operatorRunRequestSchema.parse(validInput);

    expect(result.publish).toBe(false);
    expect(result.publishConfirmed).toBe(false);
  });

  test("defaults timeoutMinutes to 30 when omitted", () => {
    const { timeoutMinutes: _ignored, ...withoutTimeout } = validInput;
    const result = operatorRunRequestSchema.parse(withoutTimeout);
    expect(result.timeoutMinutes).toBe(30);
  });

  test("requires explicit confirmation before publishing", () => {
    const result = operatorRunRequestSchema.safeParse({
      ...validInput,
      publish: true,
    });

    expect(result.success).toBe(false);
  });

  test("rejects a non-canonical issue URL", () => {
    const result = operatorRunRequestSchema.safeParse({
      ...validInput,
      issueUrl: "https://example.com/issues/12",
    });

    expect(result.success).toBe(false);
  });

  test("review mode accepts skillId without skillPath", () => {
    const missing = operatorRunRequestSchema.safeParse({
      mode: "review",
      verifyCommand: "bun test",
    });
    expect(missing.success).toBe(false);

    const valid = operatorRunRequestSchema.parse({
      mode: "review",
      pullRequestUrl: "https://github.com/dallascrilley/example/pull/9",
      skillId: "fix-review-findings",
      verifyCommand: "bun test",
    });
    expect(valid.mode).toBe("review");
    expect(valid.skillId).toBe("fix-review-findings");
    expect(valid.pullRequestUrl).toContain("/pull/9");
  });

  test("strips review skillPath at the console boundary", () => {
    const result = operatorRunRequestSchema.parse({
      mode: "review",
      pullRequestUrl: "https://github.com/dallascrilley/example/pull/9",
      skillId: "fix-review-findings",
      skillPath: "/private/skill/SKILL.md",
      verifyCommand: "bun test",
    });

    expect(result).not.toHaveProperty("skillPath");
  });

  test("fromRunId skips target URL validation", () => {
    const result = operatorRunRequestSchema.parse({
      fromRunId: "abc123",
      verifyCommand: "bun test",
      publish: false,
    });
    expect(result.fromRunId).toBe("abc123");
  });
});

describe("parseOperatorTarget", () => {
  test("parses issue and pull URLs", () => {
    expect(
      parseOperatorTarget("https://github.com/Acme/Repo/issues/42/"),
    ).toEqual({
      kind: "issue",
      owner: "Acme",
      repo: "Repo",
      number: 42,
      url: "https://github.com/Acme/Repo/issues/42",
    });
    expect(
      parseOperatorTarget("https://github.com/Acme/Repo/pull/7"),
    ).toMatchObject({ kind: "pull", number: 7, owner: "Acme", repo: "Repo" });
  });

  test("returns undefined for non-canonical URLs", () => {
    expect(
      parseOperatorTarget("https://gitlab.com/a/b/issues/1"),
    ).toBeUndefined();
  });
});

describe("detectRunModeFromUrl", () => {
  test("detects issue vs review", () => {
    expect(detectRunModeFromUrl("https://github.com/a/b/issues/1")).toBe(
      "issue",
    );
    expect(detectRunModeFromUrl("https://github.com/a/b/pull/2")).toBe(
      "review",
    );
  });
});

describe("buildRunSummary", () => {
  test("summarizes verify success and failure", () => {
    expect(
      buildRunSummary(
        baseRecord({
          status: "succeeded",
          receipt: {
            runId: "run-1",
            phase: "complete",
            issueUrl: "https://github.com/dallascrilley/example/issues/12",
            execution: {
              runtime: "demo",
              software: "demo",
              provider: "demo",
              model: "demo",
            },
            changedFiles: ["a.ts", "b.ts"],
            verification: { command: "bun test", exitCode: 0, passed: true },
          },
        }),
      ),
    ).toBe("verify passed · 2 files");

    expect(
      buildRunSummary(
        baseRecord({
          status: "failed",
          phase: "verify",
          receipt: {
            runId: "run-1",
            phase: "verify",
            issueUrl: "https://github.com/dallascrilley/example/issues/12",
            execution: {
              runtime: "demo",
              software: "demo",
              provider: "demo",
              model: "demo",
            },
            changedFiles: [],
            verification: { command: "bun test", exitCode: 1, passed: false },
          },
        }),
      ),
    ).toBe("verify failed (exit 1)");
  });

  test("summarizes cancelled", () => {
    expect(
      buildRunSummary(
        baseRecord({
          status: "failed",
          message: "Run cancelled by operator.",
          receipt: {
            runId: "run-1",
            phase: "agent",
            issueUrl: "https://github.com/dallascrilley/example/issues/12",
            execution: {
              runtime: "demo",
              software: "demo",
              provider: "demo",
              model: "demo",
            },
            changedFiles: [],
            verification: {
              command: "bun test",
              exitCode: null,
              passed: false,
            },
            errorCode: "cancelled",
          },
        }),
      ),
    ).toBe("cancelled");
  });
});

describe("resolveOperatorNextAction", () => {
  test("running run primary is cancel", () => {
    const view = resolveOperatorNextAction(
      baseRecord({ status: "running", phase: "agent" }),
    );
    expect(view.primary.type).toBe("cancel");
  });

  test("dry-run success is start_publish_run not promote", () => {
    const view = resolveOperatorNextAction(
      baseRecord({
        status: "succeeded",
        request: {
          mode: "issue",
          issueUrl: "https://github.com/dallascrilley/example/issues/12",
          pullRequestUrl: "",
          skillId: "",
          presetId: "",
          verifyCommand: "bun test",
          publish: false,
          timeoutMinutes: 30,
        },
        receipt: {
          runId: "run-1",
          phase: "complete",
          issueUrl: "https://github.com/dallascrilley/example/issues/12",
          execution: {
            runtime: "demo",
            software: "demo",
            provider: "demo",
            model: "demo",
          },
          baseSha: "91e7c16fc3754a3f89b2fe53686bd528084a3a02",
          changedFiles: ["src/a.ts"],
          verification: { command: "bun test", exitCode: 0, passed: true },
        },
      }),
    );
    expect(view.primary.type).toBe("start_publish_run");
    expect(view.primary.label).toMatch(/Start publish run/i);
    expect(view.primary.caveat).toMatch(/Does not promote/i);
    expect(view.primary.caveat).toMatch(/91e7c16/);
    expect(view.primary.type).not.toBe("open_url");
  });

  test("published success opens PR", () => {
    const view = resolveOperatorNextAction(
      baseRecord({
        request: {
          mode: "issue",
          issueUrl: "https://github.com/dallascrilley/example/issues/12",
          pullRequestUrl: "",
          skillId: "",
          presetId: "",
          verifyCommand: "bun test",
          publish: true,
          timeoutMinutes: 30,
        },
        receipt: {
          runId: "run-1",
          phase: "complete",
          issueUrl: "https://github.com/dallascrilley/example/issues/12",
          execution: {
            runtime: "demo",
            software: "demo",
            provider: "demo",
            model: "demo",
          },
          changedFiles: ["src/a.ts"],
          verification: { command: "bun test", exitCode: 0, passed: true },
          pullRequestUrl: "https://github.com/dallascrilley/example/pull/99",
        },
      }),
    );
    expect(view.primary).toMatchObject({
      type: "open_url",
      url: "https://github.com/dallascrilley/example/pull/99",
    });
  });

  test("verify failure offers edit verify retry", () => {
    const view = resolveOperatorNextAction(
      baseRecord({
        status: "failed",
        phase: "verify",
        receipt: {
          runId: "run-1",
          phase: "verify",
          issueUrl: "https://github.com/dallascrilley/example/issues/12",
          execution: {
            runtime: "demo",
            software: "demo",
            provider: "demo",
            model: "demo",
          },
          changedFiles: [],
          verification: { command: "bun test", exitCode: 1, passed: false },
        },
      }),
    );
    expect(view.primary.type).toBe("edit_verify_retry");
  });

  test("old records without target still resolve", () => {
    const view = resolveOperatorNextAction(
      baseRecord({
        target: undefined,
        status: "failed",
        phase: "agent",
        message: "boom",
      }),
    );
    expect(view.primary.type).toBe("retry_dry_run");
    expect(view.secondary[0]?.type).toBe("open_url");
  });
});

describe("resolveOperatorPublishConfirmation", () => {
  test("keeps a CTA-selected dry run when form inputs later change", () => {
    const selectedRun = baseRecord({
      runId: "run-a",
      request: {
        ...baseRecord().request,
        issueUrl: "https://github.com/dallascrilley/example/issues/1",
        verifyCommand: "bun test",
      },
    });

    const confirmation = resolveOperatorPublishConfirmation(selectedRun, {
      ...baseRecord().request,
      issueUrl: "https://github.com/dallascrilley/example/issues/2",
      verifyCommand: "bun run verify",
    });

    expect(confirmation).toMatchObject({
      sourceRunId: "run-a",
      target: "https://github.com/dallascrilley/example/issues/1",
      verifyCommand: "bun test",
    });
  });

  test("uses current form inputs when no dry run is selected", () => {
    const confirmation = resolveOperatorPublishConfirmation(null, {
      ...baseRecord().request,
      issueUrl: "https://github.com/dallascrilley/example/issues/2",
      verifyCommand: "bun run verify",
    });

    expect(confirmation).toMatchObject({
      target: "https://github.com/dallascrilley/example/issues/2",
      verifyCommand: "bun run verify",
    });
    expect(confirmation).not.toHaveProperty("sourceRunId");
  });
});

describe("summarizeOperatorRunEvent", () => {
  test("uses closed static templates only", () => {
    expect(
      summarizeOperatorRunEvent({
        kind: "queued",
        phase: "intake",
        status: "queued",
      }),
    ).toBe("Run queued");
    expect(
      summarizeOperatorRunEvent({
        kind: "phase",
        phase: "verify",
        status: "running",
      }),
    ).toBe("Verification started");
    expect(
      summarizeOperatorRunEvent({
        kind: "succeeded",
        phase: "complete",
        status: "succeeded",
        publish: false,
        changedFileCount: 2,
      }),
    ).toBe("Dry run completed · 2 changed files");
    expect(
      summarizeOperatorRunEvent({
        kind: "interrupted",
        phase: "agent",
        status: "failed",
      }),
    ).toBe("Run interrupted after service restart");
  });
});

describe("appendOperatorRunEvent", () => {
  test("dedupes adjacent identical phase/status and caps length", () => {
    const first: OperatorRunEvent = {
      at: "2026-07-20T12:00:00.000Z",
      phase: "agent",
      status: "running",
      kind: "phase",
      summary: "Agent execution started",
    };
    const dup: OperatorRunEvent = {
      ...first,
      at: "2026-07-20T12:00:01.000Z",
      summary: "Agent execution started again",
    };
    const nextPhase: OperatorRunEvent = {
      at: "2026-07-20T12:00:02.000Z",
      phase: "verify",
      status: "running",
      kind: "phase",
      summary: "Verification started",
    };
    const once = appendOperatorRunEvent([], first);
    const deduped = appendOperatorRunEvent(once, dup);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.summary).toBe("Agent execution started");
    const advanced = appendOperatorRunEvent(deduped, nextPhase);
    expect(advanced.map((event) => event.phase)).toEqual(["agent", "verify"]);

    let events: OperatorRunEvent[] = [];
    for (let i = 0; i < OPERATOR_RUN_EVENT_LIMIT + 5; i += 1) {
      events = appendOperatorRunEvent(events, {
        at: `2026-07-20T12:00:${String(i).padStart(2, "0")}.000Z`,
        phase: "agent",
        status: i % 2 === 0 ? "running" : "queued",
        kind: "phase",
        summary: `Event ${i}`,
      });
    }
    expect(events).toHaveLength(OPERATOR_RUN_EVENT_LIMIT);
  });
});

describe("operator run history list", () => {
  function rec(
    overrides: Partial<OperatorRunRecord> & { runId: string },
  ): OperatorRunRecord {
    return baseRecord({
      status: "succeeded",
      phase: "complete",
      startedAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:01:00.000Z",
      ...overrides,
    });
  }

  test("search matches target fields and summary, not receipt error text", () => {
    const record = rec({
      runId: "abc123def",
      summary: "verify passed · 2 files",
      target: {
        kind: "issue",
        owner: "acme",
        repo: "widgets",
        number: 42,
        url: "https://github.com/acme/widgets/issues/42",
        title: "Fix flaky suite",
      },
      receipt: {
        runId: "abc123def",
        phase: "complete",
        issueUrl: "https://github.com/acme/widgets/issues/42",
        execution: {
          runtime: "demo",
          software: "demo",
          provider: "demo",
          model: "demo",
        },
        changedFiles: [],
        verification: {
          command: "bun test",
          exitCode: 0,
          passed: true,
          stderrTail: "SECRET_TOKEN=super-secret-value",
        },
        errorMessage: "SECRET_TOKEN=super-secret-value",
      },
    });
    expect(matchesOperatorRunListFilters(record, { query: "widgets" })).toBe(
      true,
    );
    expect(matchesOperatorRunListFilters(record, { query: "flaky" })).toBe(
      true,
    );
    expect(matchesOperatorRunListFilters(record, { query: "abc12" })).toBe(
      true,
    );
    // substring inside run id must not match
    expect(matchesOperatorRunListFilters(record, { query: "c123" })).toBe(
      false,
    );
    expect(
      matchesOperatorRunListFilters(record, { query: "SECRET_TOKEN" }),
    ).toBe(false);
  });

  test("status mode and date filters combine", () => {
    const failed = rec({
      runId: "f1",
      status: "failed",
      phase: "verify",
      kind: "review",
      request: {
        ...baseRecord().request,
        mode: "review",
        pullRequestUrl: "https://github.com/dallascrilley/example/pull/9",
        issueUrl: "",
      },
      startedAt: "2026-07-20T10:00:00.000Z",
    });
    expect(
      matchesOperatorRunListFilters(failed, {
        status: "failed",
        mode: "review",
        from: "2026-07-20T09:00:00.000Z",
        to: "2026-07-20T11:00:00.000Z",
      }),
    ).toBe(true);
    expect(matchesOperatorRunListFilters(failed, { status: "succeeded" })).toBe(
      false,
    );
    expect(matchesOperatorRunListFilters(failed, { mode: "issue" })).toBe(
      false,
    );
  });

  test("cursor paging is stable and opaque", () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      rec({
        runId: `run-${i}`,
        startedAt: `2026-07-20T12:0${i}:00.000Z`,
      }),
    );
    const page1 = paginateOperatorRuns(records, {
      query: "",
      limit: 2,
    } as any);
    expect(page1.records.map((r) => r.runId)).toEqual(["run-4", "run-3"]);
    expect(page1.total).toBe(5);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.nextCursor!.includes("run-")).toBe(false);
    expect(decodeRunListCursor(page1.nextCursor)).toEqual({
      startedAt: "2026-07-20T12:03:00.000Z",
      runId: "run-3",
    });

    const page2 = paginateOperatorRuns(records, {
      query: "",
      limit: 2,
      cursor: page1.nextCursor,
    } as any);
    expect(page2.records.map((r) => r.runId)).toEqual(["run-2", "run-1"]);
    expect(page2.nextCursor).toBeTruthy();

    const page3 = paginateOperatorRuns(records, {
      query: "",
      limit: 2,
      cursor: page2.nextCursor,
    } as any);
    expect(page3.records.map((r) => r.runId)).toEqual(["run-0"]);
    expect(page3.nextCursor).toBeUndefined();
  });

  test("list request schema defaults limit and accepts legacy limit-only callers", () => {
    const parsed = operatorRunListRequestSchema.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.query).toBe("");
    expect(operatorRunListRequestSchema.parse({ limit: 10 }).limit).toBe(10);
  });

  test("encode/decode cursor round-trips", () => {
    const record = rec({ runId: "z1", startedAt: "2026-07-20T15:00:00.000Z" });
    const cursor = encodeRunListCursor(record);
    expect(cursor.includes("z1")).toBe(false);
    expect(decodeRunListCursor(cursor)).toEqual({
      startedAt: "2026-07-20T15:00:00.000Z",
      runId: "z1",
    });
    expect(decodeRunListCursor("not-valid")).toBeUndefined();
  });

  test("retention keeps active records and drops oldest terminals over ceiling", () => {
    const active = rec({
      runId: "active",
      status: "running",
      phase: "agent",
      startedAt: "2026-07-20T20:00:00.000Z",
    });
    const terminals = Array.from({ length: 5 }, (_, i) =>
      rec({
        runId: `t${i}`,
        startedAt: `2026-07-20T1${i}:00:00.000Z`,
      }),
    );
    const kept = selectRetainedOperatorRuns([active, ...terminals], {
      maxTerminal: 3,
    });
    const ids = new Set(kept.map((r) => r.runId));
    expect(ids.has("active")).toBe(true);
    expect(kept.filter((r) => r.status !== "running")).toHaveLength(3);
    // newest terminals kept
    expect(ids.has("t4")).toBe(true);
    expect(ids.has("t0")).toBe(false);
  });

  test("selectRetainedOperatorRuns can protect selected lineage when requested", () => {
    const root = rec({
      runId: "root",
      rootRunId: "root",
      startedAt: "2026-07-20T10:00:00.000Z",
    });
    const mid = rec({
      runId: "mid",
      parentRunId: "root",
      rootRunId: "root",
      startedAt: "2026-07-20T11:00:00.000Z",
    });
    const activeChild = rec({
      runId: "child",
      parentRunId: "mid",
      rootRunId: "root",
      status: "running",
      phase: "agent",
      startedAt: "2026-07-20T12:00:00.000Z",
    });
    const noise = Array.from({ length: 4 }, (_, i) =>
      rec({ runId: `n${i}`, startedAt: `2026-07-20T1${i}:30:00.000Z` }),
    );
    const kept = selectRetainedOperatorRuns(
      [root, mid, activeChild, ...noise],
      { maxTerminal: 1 },
    );
    const ids = new Set(kept.map((r) => r.runId));
    expect(ids.has("child")).toBe(true);
    expect(ids.has("mid")).toBe(true);
    expect(ids.has("root")).toBe(true);
  });

  test("selectRetainedOperatorRuns protects selected terminal lineage when asked", () => {
    const root = rec({
      runId: "root",
      rootRunId: "root",
      startedAt: "2026-07-20T10:00:00.000Z",
    });
    const selected = rec({
      runId: "sel",
      parentRunId: "root",
      rootRunId: "root",
      startedAt: "2026-07-20T11:00:00.000Z",
    });
    const noise = Array.from({ length: 4 }, (_, i) =>
      rec({ runId: `n${i}`, startedAt: `2026-07-20T1${i}:30:00.000Z` }),
    );
    const kept = selectRetainedOperatorRuns([root, selected, ...noise], {
      maxTerminal: 1,
      selectedRunId: "sel",
    });
    const ids = new Set(kept.map((r) => r.runId));
    expect(ids.has("sel")).toBe(true);
    expect(ids.has("root")).toBe(true);
  });
});


describe("buildOperatorChangeEvidence", () => {
  const receiptBase = {
    runId: "run-1",
    phase: "complete" as const,
    issueUrl: "https://github.com/dallascrilley/example/issues/12",
    execution: {
      runtime: "demo",
      software: "demo",
      provider: "demo",
      model: "demo",
    } as const,
    changedFiles: ["src/a.ts", "src/b.ts"],
    verification: { command: "bun test", exitCode: 0, passed: true },
    baseSha: "abcdef1234567890",
    commitSha: "1234567890abcdef",
    branch: "shipwright/issue-12",
  };

  test("returns null without a durable receipt", () => {
    expect(buildOperatorChangeEvidence(baseRecord({ receipt: undefined }))).toBeNull();
    expect(buildOperatorChangeEvidence(null)).toBeNull();
  });

  test("projects safe dry-run success fields", () => {
    const evidence = buildOperatorChangeEvidence(
      baseRecord({
        durationMs: 120000,
        finishedAt: "2026-07-20T12:02:00.000Z",
        receipt: receiptBase,
      }),
    );
    expect(evidence).toMatchObject({
      sourceRunId: "run-1",
      target: "https://github.com/dallascrilley/example/issues/12",
      mode: "issue",
      publish: false,
      startedAt: "2026-07-20T12:00:00.000Z",
      finishedAt: "2026-07-20T12:02:00.000Z",
      durationMs: 120000,
      verification: { command: "bun test", passed: true, exitCode: 0 },
      changedFileCount: 2,
      changedFiles: ["src/a.ts", "src/b.ts"],
      changedFilesTruncated: false,
      baseSha: "abcdef1234567890",
      commitSha: "1234567890abcdef",
      branch: "shipwright/issue-12",
    });
  });

  test("confirmation projection uses the prior record only", () => {
    const selectedRun = baseRecord({
      runId: "run-prior",
      receipt: {
        ...receiptBase,
        runId: "run-prior",
        changedFiles: ["src/from-prior.ts"],
        verification: { command: "bun test", exitCode: 0, passed: true },
      },
    });
    const confirmation = resolveOperatorPublishConfirmation(selectedRun, {
      ...baseRecord().request,
      issueUrl: "https://github.com/dallascrilley/example/issues/999",
      verifyCommand: "bun run verify",
    });
    const evidence = buildOperatorChangeEvidence(selectedRun);
    expect(confirmation.sourceRunId).toBe("run-prior");
    expect(confirmation.target).toBe(
      "https://github.com/dallascrilley/example/issues/12",
    );
    expect(evidence?.sourceRunId).toBe("run-prior");
    expect(evidence?.changedFiles).toEqual(["src/from-prior.ts"]);
    expect(evidence?.target).not.toContain("issues/999");
  });

  test("supports failed dry runs without inventing publish artifacts", () => {
    const evidence = buildOperatorChangeEvidence(
      baseRecord({
        status: "failed",
        phase: "verify",
        receipt: {
          ...receiptBase,
          phase: "verify",
          verification: { command: "bun test", exitCode: 1, passed: false },
          commitSha: undefined,
          pullRequestUrl: undefined,
        },
      }),
    );
    expect(evidence?.verification.passed).toBe(false);
    expect(evidence?.commitSha).toBeUndefined();
    expect(evidence?.pullRequestUrl).toBeUndefined();
  });

  test("includes PR URL for published prior runs", () => {
    const evidence = buildOperatorChangeEvidence(
      baseRecord({
        request: { ...baseRecord().request, publish: true },
        receipt: {
          ...receiptBase,
          pullRequestUrl: "https://github.com/dallascrilley/example/pull/9",
        },
      }),
    );
    expect(evidence?.publish).toBe(true);
    expect(evidence?.pullRequestUrl).toBe(
      "https://github.com/dallascrilley/example/pull/9",
    );
  });

  
  test("collapses absolute host paths to basename only", () => {
    const evidence = buildOperatorChangeEvidence(
      baseRecord({
        receipt: {
          ...receiptBase,
          changedFiles: [
            "/Users/dallascrilley/Code/shipwright/src/ops/run.ts",
            "C:\\Users\\dallascrilley\\repo\\pkg\\main.ts",
            "src/relative/keep.ts",
          ],
        },
      }),
    );
    expect(evidence?.changedFiles).toEqual([
      "run.ts",
      "main.ts",
      "src/relative/keep.ts",
    ]);
    expect(evidence?.changedFiles.join(" ")).not.toContain("Users");
    expect(evidence?.changedFiles.join(" ")).not.toContain("dallascrilley");
  });

test("redacts secret-like path segments and truncates file lists", () => {
    const files = Array.from({ length: OPERATOR_CHANGE_EVIDENCE_FILE_LIMIT + 3 }, (_, i) => {
      if (i === 0) return "src/tokens/github_pat_abcdefghijklmnopqrstuvwxyz0123456789.ts";
      return `src/file-${i}.ts`;
    });
    const evidence = buildOperatorChangeEvidence(
      baseRecord({
        receipt: {
          ...receiptBase,
          changedFiles: files,
          pullRequestUrl:
            "https://x-access-token:github_pat_abcdefghijklmnopqrstuvwxyz0123456789@github.com/dallascrilley/example/pull/9",
        },
      }),
    );
    expect(evidence?.changedFileCount).toBe(files.length);
    expect(evidence?.changedFiles).toHaveLength(OPERATOR_CHANGE_EVIDENCE_FILE_LIMIT);
    expect(evidence?.changedFilesTruncated).toBe(true);
    expect(evidence?.changedFiles[0]).toContain("[REDACTED]");
    expect(evidence?.changedFiles[0]).not.toContain("github_pat_");
    expect(evidence?.pullRequestUrl).toContain("[REDACTED]");
    expect(evidence?.pullRequestUrl).not.toContain("github_pat_");
  });
});
describe("resolveRecoverySelection", () => {
  test("prefers active over terminal records", () => {
    const selected = resolveRecoverySelection([
      baseRecord({
        runId: "old-success",
        status: "succeeded",
        startedAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:01:00.000Z",
      }),
      baseRecord({
        runId: "active",
        status: "running",
        phase: "agent",
        startedAt: "2026-07-20T12:05:00.000Z",
        updatedAt: "2026-07-20T12:06:00.000Z",
      }),
      baseRecord({
        runId: "newer-failed",
        status: "failed",
        phase: "verify",
        startedAt: "2026-07-20T12:10:00.000Z",
        updatedAt: "2026-07-20T12:11:00.000Z",
      }),
    ]);
    expect(selected?.runId).toBe("active");
  });

  test("prefers restart-interrupted over other failed runs", () => {
    const selected = resolveRecoverySelection([
      baseRecord({
        runId: "verify-fail",
        status: "failed",
        phase: "verify",
        startedAt: "2026-07-20T12:10:00.000Z",
        updatedAt: "2026-07-20T12:11:00.000Z",
        receipt: {
          runId: "verify-fail",
          phase: "verify",
          issueUrl: "https://github.com/dallascrilley/example/issues/12",
          execution: {
            runtime: "demo",
            software: "demo",
            provider: "demo",
            model: "demo",
          },
          changedFiles: [],
          verification: {
            command: "bun test",
            exitCode: 1,
            passed: false,
          },
        },
      }),
      baseRecord({
        runId: "interrupted",
        status: "failed",
        phase: "agent",
        message: RUN_INTERRUPTED_BY_RESTART_MESSAGE,
        startedAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:01:00.000Z",
      }),
    ]);
    expect(selected?.runId).toBe("interrupted");
  });

  test("prefers failed recoverable over latest success", () => {
    const selected = resolveRecoverySelection([
      baseRecord({
        runId: "success",
        status: "succeeded",
        startedAt: "2026-07-20T12:10:00.000Z",
        updatedAt: "2026-07-20T12:11:00.000Z",
      }),
      baseRecord({
        runId: "failed",
        status: "failed",
        phase: "agent",
        startedAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:01:00.000Z",
      }),
    ]);
    expect(selected?.runId).toBe("failed");
  });

  test("falls back to latest terminal when no active or failed", () => {
    const selected = resolveRecoverySelection([
      baseRecord({
        runId: "older",
        status: "succeeded",
        startedAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:01:00.000Z",
      }),
      baseRecord({
        runId: "newer",
        status: "succeeded",
        startedAt: "2026-07-20T12:10:00.000Z",
        updatedAt: "2026-07-20T12:11:00.000Z",
      }),
    ]);
    expect(selected?.runId).toBe("newer");
  });

  test("returns undefined for empty history", () => {
    expect(resolveRecoverySelection([])).toBeUndefined();
  });

  test("tie-breaks equal timestamps with stable runId order", () => {
    const twinA = baseRecord({
      runId: "run-aaa",
      status: "succeeded",
      startedAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:00:00.000Z",
    });
    const twinB = baseRecord({
      runId: "run-zzz",
      status: "succeeded",
      startedAt: "2026-07-20T12:00:00.000Z",
      updatedAt: "2026-07-20T12:00:00.000Z",
    });
    // Input order reversed across calls must still pick the same record.
    expect(resolveRecoverySelection([twinA, twinB])?.runId).toBe("run-zzz");
    expect(resolveRecoverySelection([twinB, twinA])?.runId).toBe("run-zzz");
  });
});

describe("resolveOperatorHint", () => {
  test("uses fixed restart interruption hint", () => {
    const record = baseRecord({
      status: "failed",
      phase: "agent",
      message: RUN_INTERRUPTED_BY_RESTART_MESSAGE,
    });
    expect(isRunInterruptedByRestart(record)).toBe(true);
    expect(resolveOperatorHint(record)).toMatch(/host restarted/i);
  });

  test("uses fixed cancellation hint from errorCode", () => {
    const record = baseRecord({
      status: "failed",
      receipt: {
        runId: "run-1",
        phase: "agent",
        issueUrl: "https://github.com/dallascrilley/example/issues/12",
        execution: {
          runtime: "demo",
          software: "demo",
          provider: "demo",
          model: "demo",
        },
        changedFiles: [],
        verification: {
          command: "bun test",
          exitCode: null,
          passed: false,
        },
        errorCode: "cancelled",
      },
    });
    expect(resolveOperatorHint(record)).toMatch(/Cancelled by operator/i);
  });

  test("uses fixed authorization hint from errorCode", () => {
    const record = baseRecord({
      status: "failed",
      phase: "intake",
      receipt: {
        runId: "run-1",
        phase: "intake",
        issueUrl: "https://github.com/dallascrilley/example/issues/12",
        execution: {
          runtime: "demo",
          software: "demo",
          provider: "demo",
          model: "demo",
        },
        changedFiles: [],
        verification: {
          command: "bun test",
          exitCode: null,
          passed: false,
        },
        errorCode: "not_allowlisted",
        errorMessage: "secret-looking pipeline detail must not leak into hint",
      },
    });
    const hint = resolveOperatorHint(record);
    expect(hint).toMatch(/allowlist/i);
    expect(hint).not.toMatch(/secret-looking/i);
  });

  test("uses fixed verification hint from verification outcome", () => {
    const record = baseRecord({
      status: "failed",
      phase: "verify",
      receipt: {
        runId: "run-1",
        phase: "verify",
        issueUrl: "https://github.com/dallascrilley/example/issues/12",
        execution: {
          runtime: "demo",
          software: "demo",
          provider: "demo",
          model: "demo",
        },
        changedFiles: [],
        verification: {
          command: "bun test",
          exitCode: 2,
          passed: false,
        },
      },
    });
    expect(resolveOperatorHint(record)).toMatch(/Verification failed/i);
  });

  test("preserves durable operatorHint when already set", () => {
    const record = baseRecord({
      operatorHint: "re-run required: legacy skill path removed",
      status: "failed",
      phase: "agent",
      message: RUN_INTERRUPTED_BY_RESTART_MESSAGE,
    });
    expect(resolveOperatorHint(record)).toBe(
      "re-run required: legacy skill path removed",
    );
  });
});

describe("resolveOperatorNextAction restart interruption", () => {
  test("restart interruption offers retry dry-run", () => {
    const view = resolveOperatorNextAction(
      baseRecord({
        status: "failed",
        phase: "agent",
        message: RUN_INTERRUPTED_BY_RESTART_MESSAGE,
      }),
    );
    expect(view.headline).toMatch(/Interrupted by service restart/i);
    expect(view.primary.type).toBe("retry_dry_run");
  });
});

describe("buildRunSummary restart interruption", () => {
  test("summarizes restart interruption", () => {
    expect(
      buildRunSummary(
        baseRecord({
          status: "failed",
          phase: "agent",
          message: RUN_INTERRUPTED_BY_RESTART_MESSAGE,
        }),
      ),
    ).toBe("interrupted by restart");
  });
});

describe("resolveOperatorRunLineage", () => {
  test("fresh root has self root and empty ancestors", () => {
    const root = baseRecord({ runId: "root", rootRunId: "root" });
    const lineage = resolveOperatorRunLineage(root, [root]);
    expect(lineage).toMatchObject({
      runId: "root",
      rootRunId: "root",
      ancestors: [],
      truncated: false,
    });
    expect(lineage.parentRunId).toBeUndefined();
  });

  test("dry→retry→publish chain walks parent links", () => {
    const dry = baseRecord({
      runId: "dry",
      rootRunId: "dry",
      startedAt: "2026-07-20T12:00:00.000Z",
    });
    const retry = baseRecord({
      runId: "retry",
      parentRunId: "dry",
      rootRunId: "dry",
      startedAt: "2026-07-20T12:05:00.000Z",
    });
    const publish = baseRecord({
      runId: "publish",
      parentRunId: "retry",
      rootRunId: "dry",
      request: {
        ...baseRecord().request,
        publish: true,
      },
      startedAt: "2026-07-20T12:10:00.000Z",
    });
    const lineage = resolveOperatorRunLineage(publish, [dry, retry, publish]);
    expect(lineage.parentRunId).toBe("retry");
    expect(lineage.rootRunId).toBe("dry");
    expect(lineage.ancestors.map((entry) => entry.runId)).toEqual([
      "retry",
      "dry",
    ]);
    expect(lineage.truncated).toBe(false);
  });

  test("tolerates missing parent without inventing links", () => {
    const orphan = baseRecord({
      runId: "child",
      parentRunId: "gone",
      rootRunId: "gone",
    });
    const lineage = resolveOperatorRunLineage(orphan, [orphan]);
    expect(lineage.ancestors).toEqual([{ runId: "gone", missing: true }]);
    expect(lineage.truncated).toBe(true);
  });

  test("guards against cycles", () => {
    const a = baseRecord({
      runId: "a",
      parentRunId: "b",
      rootRunId: "a",
    });
    const b = baseRecord({
      runId: "b",
      parentRunId: "a",
      rootRunId: "a",
    });
    const lineage = resolveOperatorRunLineage(a, [a, b]);
    expect(lineage.ancestors.map((entry) => entry.runId)).toEqual(["b"]);
    expect(lineage.truncated).toBe(true);
  });

  test("legacy records without lineage stay standalone", () => {
    const legacy = baseRecord({ runId: "legacy" });
    const lineage = resolveOperatorRunLineage(legacy, [legacy]);
    expect(lineage.parentRunId).toBeUndefined();
    expect(lineage.rootRunId).toBe("legacy");
    expect(lineage.ancestors).toEqual([]);
    expect(lineage.truncated).toBe(false);
  });

  test("depth cutoff marks lineage truncated", () => {
    const records: OperatorRunRecord[] = [];
    for (let i = 0; i <= MAX_LINEAGE_DEPTH + 2; i += 1) {
      const runId = `n${i}`;
      records.push(
        baseRecord({
          runId,
          parentRunId: i === 0 ? undefined : `n${i - 1}`,
          rootRunId: "n0",
        }),
      );
    }
    const leaf = records[records.length - 1]!;
    const lineage = resolveOperatorRunLineage(leaf, records);
    expect(lineage.ancestors.length).toBe(MAX_LINEAGE_DEPTH);
    expect(lineage.truncated).toBe(true);
  });
});

describe("hydrateIntakeFromRecord", () => {
  test("hydrates mode target skill preset raw verify and timeout without publish", () => {
    const record = baseRecord({
      runId: "hist-1",
      request: {
        mode: "review",
        issueUrl: "",
        pullRequestUrl: "https://github.com/dallascrilley/example/pull/9",
        skillId: "fix-review-findings",
        presetId: "",
        verifyCommand: "bun run verify",
        publish: true,
        timeoutMinutes: 45,
      },
    });
    const draft = hydrateIntakeFromRecord(record);
    expect(draft).toEqual({
      targetInput: "https://github.com/dallascrilley/example/pull/9",
      mode: "review",
      skillId: "fix-review-findings",
      presetId: "",
      verifyCommand: "bun run verify",
      useRawVerify: true,
      timeoutMinutes: 45,
      advancedOpen: true,
    });
  });

  test("preset path keeps raw verify off", () => {
    const draft = hydrateIntakeFromRecord(
      baseRecord({
        request: {
          ...baseRecord().request,
          presetId: "bun-test",
          verifyCommand: "bun test",
        },
      }),
    );
    expect(draft.useRawVerify).toBe(false);
    expect(draft.presetId).toBe("bun-test");
  });
});
