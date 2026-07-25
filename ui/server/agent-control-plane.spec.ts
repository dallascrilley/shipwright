import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { executionRequestSchema } from "../shared/agent-definition";
import type { OperatorRunRecord } from "../shared/operator-run";
import {
  AgentControlPlane,
  JsonFileAgentControlPlaneStore,
  MemoryAgentControlPlaneStore,
  RevisionConflictError,
  migrateLegacyOperatorRuns,
  type AgentControlPlaneStore,
} from "./agent-control-plane";

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
  verification: { presetId: "bun-test" },
  publicationPolicy: "dry_run" as const,
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createControlPlane(
  store: AgentControlPlaneStore = new MemoryAgentControlPlaneStore(),
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

  test("rejects unsupported new GitHub trigger pairs without mutation", () => {
    const store = new MemoryAgentControlPlaneStore();
    const controlPlane = createControlPlane(store);
    const agent = controlPlane.createAgent(draft);

    expect(() =>
      controlPlane.createTrigger({
        agentId: agent.agentId,
        expectedRevision: agent.currentRevision,
        kind: "github",
        config: { event: "pull_request", actions: ["closed"] },
      }),
    ).toThrow(/supported GitHub trigger/i);
    expect(store.load().triggers).toHaveLength(0);
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

  test("removes a trigger optimistically while retaining historical execution references", () => {
    const store = new MemoryAgentControlPlaneStore();
    const controlPlane = createControlPlane(store);
    const agent = controlPlane.createAgent(draft);
    const trigger = controlPlane.createTrigger({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      kind: "github",
      config: { event: "issues", actions: ["opened"] },
    });
    store.transaction((snapshot) => {
      snapshot.executions.push(
        executionRequestSchema.parse({
          executionId: "execution-1",
          agentId: agent.agentId,
          agentRevision: agent.currentRevision,
          triggerId: trigger.triggerId,
          source: "github",
          idempotencyKey: "github:delivery-1",
          target: {
            kind: "issue",
            owner: "dallascrilley",
            repo: "shipwright",
            number: 42,
          },
          scheduledAt: "2026-07-21T00:00:00.000Z",
          priority: 50,
          createdAt: "2026-07-21T00:00:00.000Z",
        }),
      );
    });

    const removed = controlPlane.removeTrigger({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      triggerId: trigger.triggerId,
    });

    expect(removed.triggerId).toBe(trigger.triggerId);
    expect(store.load().triggers).toHaveLength(0);
    expect(store.load().executions[0]?.triggerId).toBe(trigger.triggerId);
    expect(
      controlPlane.listLifecycleEvents(agent.agentId).slice(-1)[0],
    ).toMatchObject({
      action: "trigger_removed",
      triggerId: trigger.triggerId,
      revision: agent.currentRevision,
    });
  });

  test("rejects stale or unknown trigger removal without mutation", () => {
    const store = new MemoryAgentControlPlaneStore();
    const controlPlane = createControlPlane(store);
    const agent = controlPlane.createAgent(draft);
    const trigger = controlPlane.createTrigger({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      kind: "github",
      config: { event: "issues", actions: ["opened"] },
    });

    expect(() =>
      controlPlane.removeTrigger({
        agentId: agent.agentId,
        expectedRevision: 2,
        triggerId: trigger.triggerId,
      }),
    ).toThrow(RevisionConflictError);
    expect(() =>
      controlPlane.removeTrigger({
        agentId: agent.agentId,
        expectedRevision: agent.currentRevision,
        triggerId: "missing-trigger",
      }),
    ).toThrow(/Unknown trigger/i);
    expect(store.load().triggers).toHaveLength(1);
    expect(
      controlPlane
        .listLifecycleEvents(agent.agentId)
        .some((event) => event.action === "trigger_removed"),
    ).toBe(false);
  });

  test("replaces a trigger atomically and rejects invalid replacements without mutation", () => {
    const store = new MemoryAgentControlPlaneStore();
    const controlPlane = createControlPlane(store);
    const agent = controlPlane.createAgent(draft);
    const original = controlPlane.createTrigger({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      kind: "github",
      config: { event: "issues", actions: ["opened"] },
    });

    expect(() =>
      controlPlane.replaceTrigger({
        agentId: agent.agentId,
        expectedRevision: agent.currentRevision,
        triggerId: original.triggerId,
        kind: "github",
        config: { event: "pull_request", actions: ["closed"] },
      }),
    ).toThrow(/supported GitHub trigger/i);
    expect(() =>
      controlPlane.replaceTrigger({
        agentId: agent.agentId,
        expectedRevision: agent.currentRevision,
        triggerId: original.triggerId,
        kind: "github",
        config: { event: "pull_request", actions: ["synchronize"] },
      }),
    ).toThrow(/cannot use Commits pushed to pull request/i);
    expect(store.load().triggers).toEqual([original]);

    const replacement = controlPlane.replaceTrigger({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      triggerId: original.triggerId,
      kind: "github",
      config: { event: "issues", actions: ["edited"] },
    });

    expect(replacement).toMatchObject({
      agentId: agent.agentId,
      agentRevision: agent.currentRevision,
      kind: "github",
      config: { event: "issues", actions: ["edited"] },
    });
    expect(replacement.triggerId).not.toBe(original.triggerId);
    expect(store.load().triggers).toEqual([replacement]);
    expect(
      controlPlane.listLifecycleEvents(agent.agentId).slice(-1)[0],
    ).toMatchObject({
      action: "trigger_removed",
      triggerId: original.triggerId,
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
      events: [],
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

  test("persists validated control-plane state privately across store instances", () => {
    const directory = mkdtempSync(join(tmpdir(), "shipwright-control-plane-"));
    const path = join(directory, "state", "agent-control-plane.json");
    temporaryDirectories.push(directory);
    const store = new JsonFileAgentControlPlaneStore(path);
    const controlPlane = createControlPlane(store);

    const agent = controlPlane.createAgent(draft);
    const restored = new JsonFileAgentControlPlaneStore(path).load();

    expect(restored.agents).toHaveLength(1);
    expect(restored.agents[0]?.agentId).toBe(agent.agentId);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, "state")).mode & 0o777).toBe(0o700);
  });

  test("fails closed when durable control-plane state is malformed", () => {
    const directory = mkdtempSync(join(tmpdir(), "shipwright-control-plane-"));
    const path = join(directory, "agent-control-plane.json");
    temporaryDirectories.push(directory);
    writeFileSync(path, '{"version":1,"agents":"invalid"}\n', "utf8");

    expect(() => new JsonFileAgentControlPlaneStore(path).load()).toThrow(
      `could not load agent control-plane state at ${path}`,
    );
  });
  test("rejects github triggers that conflict with the agent action preset", () => {
    const controlPlane = createControlPlane();
    const agent = controlPlane.createAgent({
      ...draft,
      actionPreset: "resolve_pr_feedback",
      skillId: "fix-review-findings",
    });

    expect(() =>
      controlPlane.createTrigger({
        agentId: agent.agentId,
        expectedRevision: agent.currentRevision,
        kind: "github",
        config: { event: "issues", actions: ["opened"], conditions: [] },
      }),
    ).toThrow(/cannot use Issue created/);
  });

  test("rejects saving a preset that conflicts with existing github triggers", () => {
    const controlPlane = createControlPlane();
    const agent = controlPlane.createAgent(draft);
    controlPlane.createTrigger({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      kind: "github",
      config: { event: "issues", actions: ["opened"], conditions: [] },
    });

    expect(() =>
      controlPlane.updateAgent(agent.agentId, agent.currentRevision, {
        ...draft,
        actionPreset: "resolve_pr_feedback",
        skillId: "fix-review-findings",
      }),
    ).toThrow(/cannot use Issue created/);
  });

  test("rejects schedule targets that conflict with the agent action preset", () => {
    const controlPlane = createControlPlane();
    const agent = controlPlane.createAgent({
      ...draft,
      actionPreset: "resolve_pr_feedback",
      skillId: "fix-review-findings",
    });

    expect(() =>
      controlPlane.createTrigger({
        agentId: agent.agentId,
        expectedRevision: agent.currentRevision,
        kind: "schedule",
        config: {
          schedule: "0 9 * * *",
          timezone: "America/New_York",
          target: { kind: "issue", number: 42 },
        },
      }),
    ).toThrow(/cannot use schedule target kind "issue"/);
  });

  test("loads legacy drafts with issue triggers as fix_issue despite review skillId", () => {
    const directory = mkdtempSync(join(tmpdir(), "shipwright-control-plane-"));
    const path = join(directory, "agent-control-plane.json");
    temporaryDirectories.push(directory);
    writeFileSync(
      path,
      JSON.stringify(
        {
          version: 1,
          agents: [
            {
              agentId: "agent-legacy",
              currentRevision: 1,
              enabled: false,
              createdAt: "2026-07-21T00:00:00.000Z",
              updatedAt: "2026-07-21T00:00:00.000Z",
              health: { state: "idle" },
            },
          ],
          revisions: [
            {
              agentId: "agent-legacy",
              revision: 1,
              createdAt: "2026-07-21T00:00:00.000Z",
              draft: (({ actionPreset: _omit, ...rest }) => ({
                ...rest,
                skillId: "fix-review-findings",
              }))(draft),
            },
          ],
          triggers: [
            {
              triggerId: "trigger-legacy",
              agentId: "agent-legacy",
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
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const store = new JsonFileAgentControlPlaneStore(path);
    const loaded = store.load();
    expect(loaded.revisions[0]?.draft.actionPreset).toBe("fix_issue");
  });
});
