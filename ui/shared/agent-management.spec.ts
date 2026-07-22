import { describe, expect, test } from "vitest";

import { agentControlPlaneSnapshotSchema } from "./agent-definition";
import {
  agentDefinitionExportSchema,
  buildAgentDefinitionDocument,
  buildAgentTriggerView,
} from "./agent-management";

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

function createSnapshot() {
  return agentControlPlaneSnapshotSchema.parse({
    version: 1,
    agents: [
      {
        agentId: "agent-1",
        currentRevision: 2,
        enabled: false,
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:01:00.000Z",
        health: { state: "idle" },
      },
    ],
    revisions: [
      {
        agentId: "agent-1",
        revision: 2,
        createdAt: "2026-07-21T00:01:00.000Z",
        draft,
      },
    ],
    triggers: [
      {
        triggerId: "trigger-schedule",
        agentId: "agent-1",
        agentRevision: 2,
        kind: "schedule",
        enabled: true,
        config: {
          schedule: "0 9 * * *",
          timezone: "America/Chicago",
          target: { kind: "issue", number: 42 },
        },
        nextFireAt: "2026-07-21T14:00:00.000Z",
        consecutiveFailures: 0,
        createdAt: "2026-07-21T00:01:00.000Z",
        updatedAt: "2026-07-21T00:01:00.000Z",
      },
      {
        triggerId: "trigger-legacy",
        agentId: "agent-1",
        agentRevision: 2,
        kind: "github",
        enabled: true,
        config: { event: "pull_request", actions: ["closed"] },
        createdAt: "2026-07-21T00:01:00.000Z",
        updatedAt: "2026-07-21T00:01:00.000Z",
      },
      {
        triggerId: "trigger-opened",
        agentId: "agent-1",
        agentRevision: 2,
        kind: "github",
        enabled: true,
        config: { event: "issues", actions: ["opened"] },
        createdAt: "2026-07-21T00:01:00.000Z",
        updatedAt: "2026-07-21T00:01:00.000Z",
      },
    ],
    lifecycleEvents: [
      {
        eventId: "audit-event-1",
        agentId: "agent-1",
        action: "created",
        revision: 1,
        sequence: 1,
        occurredAt: "2026-07-21T00:00:00.000Z",
      },
    ],
    executions: [],
    queueEntries: [],
  });
}

describe("agent management trigger projections", () => {
  test.each([
    ["issues", "opened", "Issue created"],
    ["issues", "edited", "Issue edited"],
    ["pull_request", "opened", "Pull request created"],
    [
      "pull_request",
      "synchronize",
      "Commits pushed to pull request",
    ],
  ] as const)(
    "renders %s.%s as a readable trigger sentence",
    (event, action, label) => {
      const snapshot = createSnapshot();
      const trigger = agentControlPlaneSnapshotSchema.shape.triggers.element.parse({
        triggerId: `trigger-${event}-${action}`,
        agentId: "agent-1",
        agentRevision: 2,
        kind: "github",
        enabled: true,
        config: { event, actions: [action] },
        createdAt: "2026-07-21T00:01:00.000Z",
        updatedAt: "2026-07-21T00:01:00.000Z",
      });

      expect(
        buildAgentTriggerView(trigger, draft.targetScope.repository),
      ).toMatchObject({
        label: `${label} in dallascrilley/shipwright`,
        legacy: false,
      });
      expect(snapshot.triggers).toHaveLength(3);
    },
  );

  test("renders supported and legacy GitHub triggers without mutating them", () => {
    const snapshot = createSnapshot();
    const supported = buildAgentTriggerView(
      snapshot.triggers[2]!,
      draft.targetScope.repository,
    );
    const legacy = buildAgentTriggerView(
      snapshot.triggers[1]!,
      draft.targetScope.repository,
    );

    expect(supported).toMatchObject({
      triggerId: "trigger-opened",
      choiceId: "issue_created",
      label: "Issue created in dallascrilley/shipwright",
      legacy: false,
    });
    expect(legacy).toMatchObject({
      triggerId: "trigger-legacy",
      label: "Legacy GitHub trigger: pull_request.closed",
      legacy: true,
    });
    expect(snapshot.triggers[1]?.config).toEqual({
      event: "pull_request",
      actions: ["closed"],
    });
    expect(
      buildAgentTriggerView(
        snapshot.triggers[0]!,
        draft.targetScope.repository,
      ).label,
    ).toBe("Schedule 0 9 * * * (America/Chicago)");
  });

  test("builds a deterministic versioned secret-free configuration document", () => {
    const snapshot = createSnapshot();
    const document = buildAgentDefinitionDocument(snapshot, "agent-1");
    const serialized = JSON.stringify(document);

    expect(document).toMatchObject({
      format: "shipwright.agent",
      version: 1,
      revision: 2,
      enabled: false,
      configuration: draft,
    });
    expect(document.triggers.map((trigger) => trigger.kind)).toEqual([
      "github",
      "github",
      "schedule",
    ]);
    expect(document.triggers[0]).toMatchObject({
      kind: "github",
      event: "issues",
      actions: ["opened"],
      legacy: false,
    });
    expect(document.triggers[1]).toMatchObject({
      kind: "github",
      event: "pull_request",
      actions: ["closed"],
      legacy: true,
    });
    expect(document.triggers[2]).toMatchObject({
      kind: "schedule",
      schedule: "0 9 * * *",
      timezone: "America/Chicago",
      target: { kind: "issue", number: 42 },
      paused: false,
    });
    expect(agentDefinitionExportSchema.parse(JSON.parse(serialized))).toEqual(
      document,
    );
    expect(serialized).not.toContain("audit-event-1");
    expect(serialized).not.toContain("nextFireAt");
    expect(serialized).not.toContain("receipt");
  });
});
