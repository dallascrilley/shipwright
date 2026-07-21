import { describe, expect, test } from "vitest";

import {
  agentControlPlaneSnapshotSchema,
  agentDraftSchema,
  agentTriggerSchema,
  executionRequestSchema,
  lifecycleEventSchema,
  queueEntrySchema,
} from "./agent-definition";

const draft = {
  name: "Issue triage",
  instructions: "Triage allowlisted issues and prepare a dry run.",
  skillId: "fix-review-findings",
  allowedTools: ["github", "sandbox"],
  targetScope: {
    repository: "dallascrilley/shipwright",
    branch: "main",
  },
  verification: {
    presetId: "bun-test",
  },
  publicationPolicy: "dry_run",
};

describe("agentDefinition contracts", () => {
  test("accepts an allowlisted dry-run draft", () => {
    expect(agentDraftSchema.parse(draft)).toMatchObject({
      name: "Issue triage",
      publicationPolicy: "dry_run",
      targetScope: { repository: "dallascrilley/shipwright" },
    });
  });

  test("rejects invalid draft, trigger, and execution boundaries", () => {
    expect(agentDraftSchema.safeParse({ ...draft, name: "" }).success).toBe(false);
    expect(
      agentDraftSchema.safeParse({
        ...draft,
        targetScope: { repository: "shipwright", branch: "" },
      }).success,
    ).toBe(false);
    expect(
      agentTriggerSchema.safeParse({
        triggerId: "trigger-1",
        agentId: "agent-1",
        agentRevision: 1,
        kind: "schedule",
        enabled: true,
        config: { event: "issues", actions: ["opened"] },
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      executionRequestSchema.safeParse({
        executionId: "execution-1",
        agentId: "agent-1",
        agentRevision: 0,
        source: "test",
        idempotencyKey: "test:agent-1:0",
        target: {
          kind: "issue",
          owner: "dallascrilley",
          repo: "shipwright",
          number: 42,
        },
        createdAt: "2026-07-21T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  test("rejects secret-like values and unrecognized fields", () => {
    const secretLikeValue = `github_pat_${"x".repeat(20)}`;

    expect(
      agentDraftSchema.safeParse({
        ...draft,
        instructions: `Use ${secretLikeValue}`,
      }).success,
    ).toBe(false);
    expect(
      agentDraftSchema.safeParse({
        ...draft,
        accessToken: secretLikeValue,
      }).success,
    ).toBe(false);
    expect(
      agentTriggerSchema.safeParse({
        triggerId: "trigger-1",
        agentId: "agent-1",
        agentRevision: 2,
        kind: "github",
        enabled: true,
        config: { event: "issues", actions: [secretLikeValue] },
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      executionRequestSchema.safeParse({
        executionId: "execution-1",
        agentId: "agent-1",
        agentRevision: 2,
        source: "test",
        idempotencyKey: secretLikeValue,
        target: {
          kind: "issue",
          owner: "dallascrilley",
          repo: "shipwright",
          number: 42,
        },
        createdAt: "2026-07-21T00:00:00.000Z",
      }).success,
    ).toBe(false);
    const queueEntry = {
      queueEntryId: secretLikeValue,
      executionId: "execution-1",
      agentId: "agent-1",
      agentRevision: 2,
      state: "queued",
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
    expect(queueEntrySchema.safeParse(queueEntry).success).toBe(false);
    expect(
      lifecycleEventSchema.safeParse({
        eventId: secretLikeValue,
        agentId: "agent-1",
        action: "created",
        revision: 1,
        sequence: 1,
        occurredAt: "2026-07-21T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      agentControlPlaneSnapshotSchema.safeParse({
        version: 1,
        agents: [],
        revisions: [],
        triggers: [],
        lifecycleEvents: [],
        executions: [],
        queueEntries: [queueEntry],
      }).success,
    ).toBe(false);
  });

  test("pins trigger and execution records to an immutable revision", () => {
    expect(
      agentTriggerSchema.parse({
        triggerId: "trigger-1",
        agentId: "agent-1",
        agentRevision: 2,
        kind: "github",
        enabled: true,
        config: { event: "issues", actions: ["opened"] },
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toMatchObject({ agentRevision: 2, kind: "github" });

    expect(
      executionRequestSchema.parse({
        executionId: "execution-1",
        agentId: "agent-1",
        agentRevision: 2,
        source: "test",
        idempotencyKey: "test:agent-1:2:1",
        target: {
          kind: "issue",
          owner: "dallascrilley",
          repo: "shipwright",
          number: 42,
        },
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toMatchObject({ agentRevision: 2, source: "test" });
  });
});
