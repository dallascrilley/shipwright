import { describe, expect, test } from "vitest";

import type { OperatorRunRecord } from "../shared/operator-run";
import {
  AgentControlPlane,
  MemoryAgentControlPlaneStore,
  RevisionConflictError,
  migrateLegacyOperatorRuns,
} from "./agent-control-plane";

const draft = {
  name: "Issue triage",
  instructions: "Triage allowlisted issues and prepare a dry run.",
  skillId: "fix-review-findings",
  allowedTools: ["github", "sandbox"],
  targetScope: {
    repository: "dallascrilley/shipwright",
    branch: "main",
  },
  verification: { presetId: "bun-test" },
  publicationPolicy: "dry_run" as const,
};

function createControlPlane(
  store = new MemoryAgentControlPlaneStore(),
): AgentControlPlane {
  let id = 0;
  return new AgentControlPlane(
    store,
    () => `id-${++id}`,
    () => "2026-07-21T00:00:00.000Z",
  );
}

describe("AgentControlPlane", () => {
  test("creates a disabled agent with its first immutable revision and audit event", () => {
    const controlPlane = createControlPlane();
    const agent = controlPlane.createAgent(draft);

    expect(agent).toMatchObject({
      enabled: false,
      currentRevision: 1,
      health: { state: "idle" },
    });
    expect(controlPlane.getRevision(agent.agentId, 1)?.draft).toEqual(draft);
    expect(
      controlPlane
        .listLifecycleEvents(agent.agentId)
        .map((event) => event.action),
    ).toEqual(["created"]);
  });

  test("fails loud on a stale revision and preserves historic revisions", () => {
    const controlPlane = createControlPlane();
    const agent = controlPlane.createAgent(draft);
    const original = controlPlane.getRevision(agent.agentId, 1);

    const updated = controlPlane.updateAgent(agent.agentId, 1, {
      ...draft,
      name: "Updated triage",
    });

    expect(updated.currentRevision).toBe(2);
    expect(controlPlane.getRevision(agent.agentId, 1)).toEqual(original);
    expect(() => controlPlane.updateAgent(agent.agentId, 1, draft)).toThrow(
      RevisionConflictError,
    );
  });

  test("rejects stale lifecycle mutations without appending audit events", () => {
    const controlPlane = createControlPlane();
    const agent = controlPlane.createAgent(draft);

    expect(() => controlPlane.setEnabled(agent.agentId, 2, true)).toThrow(
      RevisionConflictError,
    );
    expect(() =>
      controlPlane.createTrigger({
        agentId: agent.agentId,
        expectedRevision: 2,
        kind: "github",
        config: { event: "issues", actions: ["opened"] },
      }),
    ).toThrow(RevisionConflictError);
    expect(controlPlane.listLifecycleEvents(agent.agentId)).toHaveLength(1);
  });

  test("orders lifecycle audit events and pins triggers to the active revision", () => {
    const controlPlane = createControlPlane();
    const agent = controlPlane.createAgent(draft);
    const updated = controlPlane.updateAgent(agent.agentId, 1, {
      ...draft,
      publicationPolicy: "approval_required",
    });
    controlPlane.setEnabled(agent.agentId, updated.currentRevision, true);
    const trigger = controlPlane.createTrigger({
      agentId: agent.agentId,
      expectedRevision: updated.currentRevision,
      kind: "github",
      config: { event: "issues", actions: ["opened"] },
    });

    expect(trigger).toMatchObject({
      agentId: agent.agentId,
      agentRevision: 2,
      kind: "github",
    });
    expect(
      controlPlane
        .listLifecycleEvents(agent.agentId)
        .map((event) => event.action),
    ).toEqual(["created", "updated", "policy_changed", "enabled"]);
    expect(
      controlPlane
        .listLifecycleEvents(agent.agentId)
        .map((event) => event.sequence),
    ).toEqual([1, 2, 3, 4]);
  });

  test("initializes a schedule trigger with its first computed occurrence", () => {
    const controlPlane = createControlPlane();
    const agent = controlPlane.createAgent(draft);

    const trigger = controlPlane.createTrigger({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      kind: "schedule",
      config: {
        schedule: "0 9 * * *",
        timezone: "America/New_York",
        target: { kind: "issue", number: 42 },
      },
    });

    expect(trigger).toMatchObject({
      agentId: agent.agentId,
      kind: "schedule",
      consecutiveFailures: 0,
      nextFireAt: "2026-07-21T13:00:00.000Z",
    });
  });

  test("keeps legacy P0 run records standalone during migration", () => {
    const legacy: OperatorRunRecord = {
      runId: "legacy-run",
      status: "succeeded",
      phase: "complete",
      kind: "issue",
      request: {
        mode: "issue",
        issueUrl: "https://github.com/dallascrilley/shipwright/issues/42",
        pullRequestUrl: "",
        skillId: "",
        presetId: "bun-test",
        verifyCommand: "bun test",
        publish: false,
        timeoutMinutes: 30,
      },
      startedAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:01:00.000Z",
    };

    const migrated = migrateLegacyOperatorRuns([legacy]);

    expect(migrated).toEqual([legacy]);
    expect(migrated[0]).not.toHaveProperty("agentId");
    expect(migrated[0]).not.toHaveProperty("agentRevision");
    expect(migrated[0]).not.toBe(legacy);
  });

  test("initializes an empty transactional store and migrates no legacy history", () => {
    const store = new MemoryAgentControlPlaneStore();

    expect(store.load()).toMatchObject({
      version: 1,
      agents: [],
      revisions: [],
      triggers: [],
      lifecycleEvents: [],
      executions: [],
      queueEntries: [],
    });
    expect(migrateLegacyOperatorRuns([])).toEqual([]);
  });
});
