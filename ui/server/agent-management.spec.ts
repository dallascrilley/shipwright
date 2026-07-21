import { describe, expect, test } from "vitest";

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

function createService() {
  let sequence = 0;
  return new AgentManagementService({
    createId: () => `id-${++sequence}`,
    now: () => "2026-07-21T12:00:00.000Z",
  });
}

describe("AgentManagementService", () => {
  test("creates disabled agents and requires a validated trigger before enable", () => {
    const service = createService();
    const created = service.createAgent(draft);

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

  test("saves an immutable revision and queues a test run against that revision", () => {
    const service = createService();
    const created = service.createAgent(draft);
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
    const saved = service.saveAgent({
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

  test("pauses and resumes a schedule trigger through the management boundary", () => {
    const service = createService();
    const created = service.createAgent(draft);
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

  test("projects searchable non-secret list data and supports emergency stop", () => {
    const service = createService();
    const created = service.createAgent(draft);
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

  test("rejects secret-like configuration before it reaches a UI response", () => {
    const service = createService();

    expect(() =>
      service.createAgent({
        ...draft,
        instructions: "Use token ghp_0123456789012345678901234567890123456789",
      }),
    ).toThrow("Secret-like");
  });
});
