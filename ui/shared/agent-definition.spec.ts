import { describe, expect, test } from "vitest";

import {
  GITHUB_TRIGGER_CONDITION_LIMITS,
  GITHUB_TRIGGER_CONDITION_CATALOG,
  GITHUB_TRIGGER_CHOICES,
  agentControlPlaneSnapshotSchema,
  agentDraftSchema,
  agentTriggerSchema,
  curatedGithubTriggerConfigSchema,
  defaultSkillIdForActionPreset,
  defaultTargetKindForActionPreset,
  executionRequestSchema,
  findGithubTriggerChoice,
  githubEventAllowedForActionPreset,
  githubTriggerConditionSchema,
  inferActionPresetFromLegacyDraft,
  migrateLegacyActionPresetsInSnapshot,
  lifecycleEventSchema,
  queueEntrySchema,
  validateActionPresetAgainstAgentTriggers,
  validateActionPresetGithubTriggerConsistency,
  validateActionPresetScheduleTriggerConsistency,
} from "./agent-definition";

const draft = {
  name: "Issue triage",
  instructions: "Triage allowlisted issues and prepare a dry run.",
  actionPreset: "fix_issue" as const,
  skillId: "",
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
  test("defines the curated GitHub trigger choices including review wakes", () => {
    expect(GITHUB_TRIGGER_CHOICES.map((choice) => choice.id)).toEqual([
      "issue_created",
      "issue_edited",
      "pull_request_created",
      "pull_request_pushed",
      "pull_request_review_comment_created",
      "pull_request_review_submitted",
    ]);
    for (const choice of GITHUB_TRIGGER_CHOICES) {
      const config = { event: choice.event, actions: [choice.action] };
      expect(curatedGithubTriggerConfigSchema.safeParse(config).success).toBe(
        true,
      );
      expect(findGithubTriggerChoice(config)?.id).toBe(choice.id);
    }
    expect(
      curatedGithubTriggerConfigSchema.safeParse({
        event: "issues",
        actions: ["opened", "edited"],
      }).success,
    ).toBe(false);
    expect(
      curatedGithubTriggerConfigSchema.safeParse({
        event: "pull_request",
        actions: ["closed"],
      }).success,
    ).toBe(false);
    expect(
      curatedGithubTriggerConfigSchema.safeParse({
        event: "pull_request_review_comment",
        actions: ["edited"],
      }).success,
    ).toBe(false);
    expect(
      curatedGithubTriggerConfigSchema.safeParse({
        event: "pull_request_review",
        actions: ["dismissed"],
      }).success,
    ).toBe(false);
  });

  test("keeps persisted legacy GitHub actions readable", () => {
    const legacy = agentTriggerSchema.parse({
      triggerId: "trigger-legacy",
      agentId: "agent-1",
      agentRevision: 1,
      kind: "github",
      enabled: true,
      config: { event: "pull_request", actions: ["closed"] },
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    });

    expect(legacy.config).toEqual({
      event: "pull_request",
      actions: ["closed"],
    });
    if (!("event" in legacy.config)) throw new Error("expected GitHub config");
    expect(findGithubTriggerChoice(legacy.config)).toBeUndefined();
  });

  test("accepts and normalizes typed event-aware GitHub conditions", () => {
    const issueConfig = curatedGithubTriggerConfigSchema.parse({
      event: "issues",
      actions: ["opened"],
      conditions: [
        {
          field: "actor",
          operator: "is_one_of",
          values: [" Alice ", "alice", "BOB", "BOB "],
        },
        {
          field: "labels",
          operator: "include_all",
          values: [" Bug ", "bug", "Urgent"],
        },
      ],
    });

    expect(issueConfig.conditions).toEqual([
      {
        field: "actor",
        operator: "is_one_of",
        values: ["Alice", "BOB"],
      },
      {
        field: "labels",
        operator: "include_all",
        values: ["Bug", "Urgent"],
      },
    ]);

    const pullRequestConfig = curatedGithubTriggerConfigSchema.parse({
      event: "pull_request",
      actions: ["opened"],
      conditions: [
        {
          field: "base_branch",
          operator: "is_not_one_of",
          values: ["main", "Main", "main"],
        },
        { field: "draft_state", operator: "is_not_draft" },
      ],
    });

    expect(pullRequestConfig.conditions).toEqual([
      {
        field: "base_branch",
        operator: "is_not_one_of",
        values: ["main", "Main"],
      },
      { field: "draft_state", operator: "is_not_draft" },
    ]);
  });

  test("publishes only event-applicable condition fields", () => {
    const fieldsFor = (
      event:
        | "issues"
        | "pull_request"
        | "pull_request_review_comment"
        | "pull_request_review",
    ) =>
      GITHUB_TRIGGER_CONDITION_CATALOG.filter((item) =>
        (item.events as readonly string[]).includes(event),
      ).map((item) => item.field);

    expect(fieldsFor("issues")).toEqual(["actor", "labels"]);
    expect(fieldsFor("pull_request")).toEqual([
      "actor",
      "labels",
      "base_branch",
      "draft_state",
    ]);
    expect(fieldsFor("pull_request_review_comment")).toEqual([
      "actor",
      "labels",
      "base_branch",
      "draft_state",
    ]);
    expect(fieldsFor("pull_request_review")).toEqual([
      "actor",
      "labels",
      "base_branch",
      "draft_state",
    ]);
  });

  test("rejects unsupported condition combinations and out-of-bound values", () => {
    expect(
      curatedGithubTriggerConfigSchema.safeParse({
        event: "issues",
        actions: ["opened"],
        conditions: [
          {
            field: "base_branch",
            operator: "is_one_of",
            values: ["main"],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      githubTriggerConditionSchema.safeParse({
        field: "labels",
        operator: "is_one_of",
        values: ["bug"],
      }).success,
    ).toBe(false);
    expect(
      githubTriggerConditionSchema.safeParse({
        field: "draft_state",
        operator: "is_draft",
        values: ["true"],
      }).success,
    ).toBe(false);
    expect(
      curatedGithubTriggerConfigSchema.safeParse({
        event: "issues",
        actions: ["opened"],
        conditions: Array.from(
          { length: GITHUB_TRIGGER_CONDITION_LIMITS.rows + 1 },
          () => ({
            field: "actor",
            operator: "is_one_of",
            values: ["octocat"],
          }),
        ),
      }).success,
    ).toBe(false);
    expect(
      githubTriggerConditionSchema.safeParse({
        field: "actor",
        operator: "is_one_of",
        values: Array.from(
          { length: GITHUB_TRIGGER_CONDITION_LIMITS.values + 1 },
          (_, index) => `user-${index}`,
        ),
      }).success,
    ).toBe(false);
    expect(
      githubTriggerConditionSchema.safeParse({
        field: "base_branch",
        operator: "is_one_of",
        values: ["x".repeat(GITHUB_TRIGGER_CONDITION_LIMITS.valueLength + 1)],
      }).success,
    ).toBe(false);
    expect(
      githubTriggerConditionSchema.safeParse({
        field: "labels",
        operator: "include_any",
        values: ["   "],
      }).success,
    ).toBe(false);
  });

  test("accepts an allowlisted dry-run draft", () => {
    expect(agentDraftSchema.parse(draft)).toMatchObject({
      name: "Issue triage",
      actionPreset: "fix_issue",
      publicationPolicy: "dry_run",
      targetScope: { repository: "dallascrilley/shipwright" },
    });
  });

  test("rejects invalid draft, trigger, and execution boundaries", () => {
    expect(agentDraftSchema.safeParse({ ...draft, name: "" }).success).toBe(
      false,
    );
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
        scheduledAt: "2026-07-21T00:00:00.000Z",
        priority: 0,
        createdAt: "2026-07-21T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  test("requires bounded runnable schedule trigger state", () => {
    const trigger = {
      triggerId: "schedule-1",
      agentId: "agent-1",
      agentRevision: 1,
      kind: "schedule" as const,
      enabled: true,
      config: {
        schedule: "0 9 * * *",
        timezone: "America/New_York",
        target: { kind: "issue" as const, number: 42 },
      },
      nextFireAt: "2026-07-21T13:00:00.000Z",
      consecutiveFailures: 0,
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };

    expect(agentTriggerSchema.safeParse(trigger).success).toBe(true);
    expect(
      agentTriggerSchema.safeParse({
        ...trigger,
        config: { ...trigger.config, schedule: "* * * * *" },
      }).success,
    ).toBe(false);
    expect(
      agentTriggerSchema.safeParse({
        ...trigger,
        config: {
          ...trigger.config,
          target: {
            ...trigger.config.target,
            number: Number.MAX_SAFE_INTEGER + 1,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      agentTriggerSchema.safeParse({
        ...trigger,
        nextFireAt: undefined,
      }).success,
    ).toBe(false);
    expect(
      lifecycleEventSchema.safeParse({
        eventId: "event-1",
        agentId: "agent-1",
        action: "circuit_open",
        revision: 1,
        sequence: 1,
        occurredAt: "2026-07-21T00:00:00.000Z",
      }).success,
    ).toBe(true);
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
        scheduledAt: "2026-07-21T00:00:00.000Z",
        priority: 0,
        createdAt: "2026-07-21T00:00:00.000Z",
      }).success,
    ).toBe(false);
    const queueEntry = {
      queueEntryId: secretLikeValue,
      executionId: "execution-1",
      agentId: "agent-1",
      agentRevision: 2,
      state: "queued",
      scheduledAt: "2026-07-21T00:00:00.000Z",
      priority: 0,
      attempts: 0,
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
        scheduledAt: "2026-07-21T00:00:00.000Z",
        priority: 0,
        createdAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toMatchObject({ agentRevision: 2, source: "test" });
  });
});

describe("action preset contracts", () => {
  test("infers resolve_pr_feedback from legacy review skillId", () => {
    expect(
      agentDraftSchema.parse({
        ...draft,
        actionPreset: undefined,
        skillId: "fix-review-findings",
      }).actionPreset,
    ).toBe("resolve_pr_feedback");
  });

  test("defaults legacy drafts without actionPreset to fix_issue", () => {
    expect(agentDraftSchema.parse({ ...draft, actionPreset: undefined }).actionPreset).toBe(
      "fix_issue",
    );
  });

  test("infers preset from unambiguous github triggers", () => {
    expect(
      inferActionPresetFromLegacyDraft(
        { skillId: "fix-review-findings" },
        [
          {
            kind: "github",
            config: { event: "pull_request", actions: ["opened"] },
          },
        ],
      ),
    ).toBe("resolve_pr_feedback");
    expect(
      inferActionPresetFromLegacyDraft(
        { skillId: "fix-review-findings" },
        [{ kind: "github", config: { event: "issues", actions: ["opened"] } }],
      ),
    ).toBe("fix_issue");
  });

  test("infers preset from unambiguous schedule targets before skillId", () => {
    expect(
      inferActionPresetFromLegacyDraft(
        { skillId: "fix-review-findings" },
        [
          {
            kind: "schedule",
            config: {
              schedule: "0 9 * * *",
              timezone: "UTC",
              target: { kind: "issue", number: 12 },
            },
          },
        ],
      ),
    ).toBe("fix_issue");
    expect(
      inferActionPresetFromLegacyDraft(
        { skillId: "" },
        [
          {
            kind: "schedule",
            config: {
              schedule: "0 9 * * *",
              timezone: "UTC",
              target: { kind: "pull", number: 3 },
            },
          },
        ],
      ),
    ).toBe("resolve_pr_feedback");
  });

  test("maps presets to default target kinds", () => {
    expect(defaultTargetKindForActionPreset("fix_issue")).toBe("issue");
    expect(defaultTargetKindForActionPreset("resolve_pr_feedback")).toBe("pull");
  });

  test("maps preset defaults to skillId", () => {
    expect(defaultSkillIdForActionPreset("fix_issue")).toBe("");
    expect(defaultSkillIdForActionPreset("resolve_pr_feedback")).toBe(
      "fix-review-findings",
    );
  });

  test("rejects resolve_pr_feedback drafts without a review skillId", () => {
    expect(
      agentDraftSchema.safeParse({
        ...draft,
        actionPreset: "resolve_pr_feedback",
        skillId: "",
      }).success,
    ).toBe(false);
  });

  test("validates github trigger families against presets", () => {
    expect(githubEventAllowedForActionPreset("fix_issue", "issues")).toBe(true);
    expect(githubEventAllowedForActionPreset("fix_issue", "pull_request")).toBe(
      false,
    );
    expect(
      validateActionPresetGithubTriggerConsistency("fix_issue", {
        event: "pull_request",
        actions: ["opened"],
        conditions: [],
      }),
    ).toMatch(/cannot use/);
  });

  test("validates schedule target kinds against presets", () => {
    expect(
      validateActionPresetScheduleTriggerConsistency("resolve_pr_feedback", {
        target: { kind: "issue" },
      }),
    ).toMatch(/cannot use schedule target kind "issue"/);
    expect(
      validateActionPresetAgainstAgentTriggers("fix_issue", [
        {
          kind: "schedule",
          config: {
            schedule: "0 9 * * *",
            timezone: "UTC",
            target: { kind: "pull", number: 7 },
          },
        },
      ]),
    ).toMatch(/cannot use schedule target kind "pull"/);
  });

  test("migrates legacy snapshot drafts using agent triggers", () => {
    const migrated = agentControlPlaneSnapshotSchema.parse({
      version: 1,
      agents: [
        {
          agentId: "agent-1",
          currentRevision: 1,
          enabled: false,
          createdAt: "2026-07-21T00:00:00.000Z",
          updatedAt: "2026-07-21T00:00:00.000Z",
          health: { state: "idle" },
        },
      ],
      revisions: [
        {
          agentId: "agent-1",
          revision: 1,
          createdAt: "2026-07-21T00:00:00.000Z",
          draft: {
            ...draft,
            actionPreset: undefined,
            skillId: "fix-review-findings",
          },
        },
      ],
      triggers: [
        {
          triggerId: "trigger-1",
          agentId: "agent-1",
          agentRevision: 1,
          kind: "github",
          enabled: true,
          config: { event: "issues", actions: ["opened"], conditions: [] },
          createdAt: "2026-07-21T00:00:00.000Z",
          updatedAt: "2026-07-21T00:00:00.000Z",
        },
      ],
      lifecycleEvents: [],
      executions: [],
      queueEntries: [],
    });
    expect(migrated.revisions[0]?.draft.actionPreset).toBe("fix_issue");
  });

  test("migrates schedule-only legacy drafts from target kind", () => {
    const snapshot = migrateLegacyActionPresetsInSnapshot({
      version: 1,
      agents: [
        {
          agentId: "agent-schedule",
          currentRevision: 1,
          enabled: false,
          createdAt: "2026-07-21T00:00:00.000Z",
          updatedAt: "2026-07-21T00:00:00.000Z",
          health: { state: "idle" },
        },
      ],
      revisions: [
        {
          agentId: "agent-schedule",
          revision: 1,
          createdAt: "2026-07-21T00:00:00.000Z",
          draft: { ...draft, skillId: "fix-review-findings", actionPreset: undefined },
        },
      ],
      triggers: [
        {
          triggerId: "trigger-schedule",
          agentId: "agent-schedule",
          agentRevision: 1,
          kind: "schedule",
          enabled: true,
          config: {
            schedule: "0 9 * * *",
            timezone: "UTC",
            target: { kind: "issue", number: 9 },
          },
          nextFireAt: "2026-07-21T09:00:00.000Z",
          consecutiveFailures: 0,
          createdAt: "2026-07-21T00:00:00.000Z",
          updatedAt: "2026-07-21T00:00:00.000Z",
        },
      ],
      lifecycleEvents: [],
      executions: [],
      queueEntries: [],
    }) as {
      revisions: { draft: { actionPreset: string } }[];
    };
    expect(snapshot.revisions[0]?.draft.actionPreset).toBe("fix_issue");
  });

});
