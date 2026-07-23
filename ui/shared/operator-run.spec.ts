import { describe, expect, test } from "vitest";

import {
  appendOperatorRunEvent,
  buildRunSummary,
  detectRunModeFromUrl,
  OPERATOR_RUN_EVENT_LIMIT,
  operatorRunRequestSchema,
  parseOperatorTarget,
  resolveOperatorNextAction,
  resolveOperatorPublishConfirmation,
  summarizeOperatorRunEvent,
  type OperatorRunEvent,
  type OperatorRunRecord,
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
    expect(parseOperatorTarget("https://gitlab.com/a/b/issues/1")).toBeUndefined();
  });
});

describe("detectRunModeFromUrl", () => {
  test("detects issue vs review", () => {
    expect(
      detectRunModeFromUrl("https://github.com/a/b/issues/1"),
    ).toBe("issue");
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
