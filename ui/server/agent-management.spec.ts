import { describe, expect, test, vi } from "vitest";

import { MemoryAgentControlPlaneStore } from "./agent-control-plane";
import { AgentManagementService } from "./agent-management";

const draft = {
  name: "Dependency fixer",
  instructions:
    "Repair the requested issue and run the configured verification.",
  skillId: "fix-review-findings",
  allowedTools: ["github", "terminal"],
  targetScope: {
    repository: "dallascrilley/shipwright",
    branch: "main",
  },
  verification: { presetId: "bun-test" },
  publicationPolicy: "dry_run" as const,
  cancelInFlight: true,
};

const selectableRepository = {
  repository: "dallascrilley/shipwright",
  owner: "dallascrilley",
  name: "shipwright",
  defaultBranch: "main",
  visibility: "private" as const,
  archived: false,
  selectable: true,
};

function createService(
  assertSelectable = vi.fn(async () => selectableRepository),
) {
  let sequence = 0;
  return new AgentManagementService({
    store: new MemoryAgentControlPlaneStore(),
    createId: () => `id-${++sequence}`,
    now: () => "2026-07-21T12:00:00.000Z",
    repositoryCatalog: { assertSelectable },
  });
}

describe("AgentManagementService", () => {
  test("creates disabled agents and requires a validated trigger before enable", async () => {
    const service = createService();
    const created = await service.createAgent(draft);

    expect(created.enabled).toBe(false);
    expect(() =>
      service.setAgentEnabled({
        agentId: created.agentId,
        expectedRevision: created.currentRevision,
        enabled: true,
      }),
    ).toThrow("at least one enabled trigger");

    service.createTrigger({
      agentId: created.agentId,
      expectedRevision: created.currentRevision,
      kind: "github",
      config: { event: "issues", actions: ["opened"] },
    });

    expect(
      service.setAgentEnabled({
        agentId: created.agentId,
        expectedRevision: created.currentRevision,
        enabled: true,
      }).enabled,
    ).toBe(true);
  });

  test("saves an immutable revision and queues a test run against that revision", async () => {
    const service = createService();
    const created = await service.createAgent(draft);
    service.createTrigger({
      agentId: created.agentId,
      expectedRevision: created.currentRevision,
      kind: "github",
      config: { event: "issues", actions: ["opened"] },
    });
    service.setAgentEnabled({
      agentId: created.agentId,
      expectedRevision: created.currentRevision,
      enabled: true,
    });
    const saved = await service.saveAgent({
      agentId: created.agentId,
      expectedRevision: created.currentRevision,
      draft: { ...draft, publicationPolicy: "approval_required" },
    });

    const queued = service.queueTestRun({
      agentId: saved.agentId,
      expectedRevision: saved.currentRevision,
      target: { kind: "issue", number: 42 },
    });

    expect(saved.currentRevision).toBe(2);
    expect(queued.execution.agentRevision).toBe(saved.currentRevision);
    expect(queued.entry.state).toBe("queued");
    expect(service.getAgent(created.agentId)?.config.publicationPolicy).toBe(
      "approval_required",
    );
  });

  test("queues an explicit dry-run test while the agent remains disabled", async () => {
    const service = createService();
    const created = await service.createAgent(draft);
    service.createTrigger({
      agentId: created.agentId,
      expectedRevision: created.currentRevision,
      kind: "github",
      config: { event: "issues", actions: ["opened"] },
    });

    const queued = service.queueTestRun({
      agentId: created.agentId,
      expectedRevision: created.currentRevision,
      target: { kind: "issue", number: 42 },
    });

    expect(queued.execution.source).toBe("test");
    expect(queued.entry.state).toBe("queued");
    expect(service.getAgent(created.agentId)?.enabled).toBe(false);
  });

  test("pauses and resumes a schedule trigger through the management boundary", async () => {
    const service = createService();
    const created = await service.createAgent(draft);
    const trigger = service.createTrigger({
      agentId: created.agentId,
      expectedRevision: created.currentRevision,
      kind: "schedule",
      config: {
        schedule: "*/5 * * * *",
        timezone: "UTC",
        target: { kind: "issue", number: 42 },
      },
    });

    expect(service.pauseScheduleTrigger(trigger.triggerId).pausedAt).toBe(
      "2026-07-21T12:00:00.000Z",
    );
    expect(
      service.resumeScheduleTrigger(trigger.triggerId).pausedAt,
    ).toBeUndefined();
    expect(service.getAgent(created.agentId)?.audit[0]?.action).toBe("resumed");
  });

  test("projects searchable non-secret list data and supports emergency stop", async () => {
    const service = createService();
    const created = await service.createAgent(draft);
    service.createTrigger({
      agentId: created.agentId,
      expectedRevision: created.currentRevision,
      kind: "schedule",
      config: {
        schedule: "*/5 * * * *",
        timezone: "UTC",
        target: { kind: "issue", number: 42 },
      },
    });
    service.setAgentEnabled({
      agentId: created.agentId,
      expectedRevision: created.currentRevision,
      enabled: true,
    });
    service.queueTestRun({
      agentId: created.agentId,
      expectedRevision: created.currentRevision,
      target: { kind: "issue", number: 42 },
    });

    const list = service.listAgents({ query: "dependency" });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      agentId: created.agentId,
      enabled: true,
      queuedRuns: 1,
      runsLastSevenDays: 1,
    });
    expect(JSON.stringify(list)).not.toContain(draft.instructions);

    const stopped = service.emergencyStop({
      agentId: created.agentId,
      expectedRevision: created.currentRevision,
    });
    expect(stopped.enabled).toBe(false);
    expect(service.getAgent(created.agentId)?.audit[0]?.action).toBe("stopped");
  });

  test("rejects secret-like configuration before it reaches a UI response", async () => {
    const service = createService();

    await expect(
      service.createAgent({
        ...draft,
        instructions: "Use token ghp_0123456789012345678901234567890123456789",
      }),
    ).rejects.toThrow("Secret-like");
  });

  test("rejects an inaccessible repository before creating an agent", async () => {
    const assertSelectable = vi.fn(async () => {
      throw new Error("Repository foreign/nope is not accessible.");
    });
    const service = createService(assertSelectable);

    await expect(
      service.createAgent({
        ...draft,
        targetScope: { ...draft.targetScope, repository: "foreign/nope" },
      }),
    ).rejects.toThrow(/not accessible/i);
    expect(service.getSnapshot().agents).toHaveLength(0);
    expect(service.getSnapshot().revisions).toHaveLength(0);
  });

  test("rejects a repository-changing save without creating a revision", async () => {
    const assertSelectable = vi.fn(async () => selectableRepository);
    const service = createService(assertSelectable);
    const created = await service.createAgent(draft);
    assertSelectable.mockRejectedValueOnce(
      new Error("Repository dallascrilley/other is not accessible."),
    );

    await expect(
      service.saveAgent({
        agentId: created.agentId,
        expectedRevision: created.currentRevision,
        draft: {
          ...draft,
          targetScope: {
            ...draft.targetScope,
            repository: "dallascrilley/other",
          },
        },
      }),
    ).rejects.toThrow(/not accessible/i);
    expect(service.getSnapshot().revisions).toHaveLength(1);
  });

  test("allows an unchanged repository save during a catalog outage", async () => {
    const assertSelectable = vi.fn(async () => selectableRepository);
    const service = createService(assertSelectable);
    const created = await service.createAgent(draft);
    assertSelectable.mockRejectedValueOnce(
      new Error("GitHub repositories could not be loaded."),
    );

    const saved = await service.saveAgent({
      agentId: created.agentId,
      expectedRevision: created.currentRevision,
      draft: { ...draft, name: "Dependency fixer v2" },
    });

    expect(saved.currentRevision).toBe(2);
    expect(assertSelectable).toHaveBeenCalledTimes(1);
  });

  test("exports the current safe definition and removes its active trigger", async () => {
    const service = createService();
    const created = await service.createAgent(draft);
    const trigger = service.createTrigger({
      agentId: created.agentId,
      expectedRevision: created.currentRevision,
      kind: "github",
      config: { event: "pull_request", actions: ["synchronize"] },
    });

    expect(service.exportAgentDefinition(created.agentId)).toMatchObject({
      format: "shipwright.agent",
      version: 2,
      revision: 1,
      configuration: draft,
      triggers: [
        {
          kind: "github",
          event: "pull_request",
          actions: ["synchronize"],
          conditions: [],
          legacy: false,
        },
      ],
    });

    expect(
      service.removeTrigger({
        agentId: created.agentId,
        expectedRevision: created.currentRevision,
        triggerId: trigger.triggerId,
      }).triggerId,
    ).toBe(trigger.triggerId);
    expect(service.getAgent(created.agentId)?.triggers).toHaveLength(0);
    expect(service.getAgent(created.agentId)?.audit[0]).toMatchObject({
      action: "trigger_removed",
      triggerId: trigger.triggerId,
    });
  });

  test("persists normalized conditions through create and atomic replace", async () => {
    const service = createService();
    const created = await service.createAgent(draft);
    const trigger = service.createTrigger({
      agentId: created.agentId,
      expectedRevision: created.currentRevision,
      kind: "github",
      config: {
        event: "issues",
        actions: ["opened"],
        conditions: [
          {
            field: "actor",
            operator: "is_one_of",
            values: [" Alice ", "alice", "Bob"],
          },
        ],
      },
    });

    expect(trigger.config).toMatchObject({
      conditions: [
        {
          field: "actor",
          operator: "is_one_of",
          values: ["Alice", "Bob"],
        },
      ],
    });

    const replacement = service.replaceTrigger({
      agentId: created.agentId,
      expectedRevision: created.currentRevision,
      triggerId: trigger.triggerId,
      kind: "github",
      config: {
        event: "pull_request",
        actions: ["opened"],
        conditions: [
          {
            field: "base_branch",
            operator: "is_one_of",
            values: ["main"],
          },
          { field: "draft_state", operator: "is_not_draft" },
        ],
      },
    });

    expect(service.getAgent(created.agentId)?.triggers).toHaveLength(1);
    expect(replacement.config).toMatchObject({
      conditions: [
        {
          field: "base_branch",
          operator: "is_one_of",
          values: ["main"],
        },
        { field: "draft_state", operator: "is_not_draft" },
      ],
    });
    expect(service.getAgent(created.agentId)?.triggers[0]?.label).toContain(
      "when base branch is one of main and draft state is not draft",
    );

    expect(() =>
      service.createTrigger({
        agentId: created.agentId,
        expectedRevision: created.currentRevision,
        kind: "github",
        config: {
          event: "issues",
          actions: ["opened"],
          conditions: [
            {
              field: "base_branch",
              operator: "is_one_of",
              values: ["main"],
            },
          ],
        },
      }),
    ).toThrow(/only available for pull request/i);
  });
});
