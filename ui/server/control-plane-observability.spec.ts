import { describe, expect, test } from "vitest";

import {
  agentDefinitionSchema,
  type AgentControlPlaneSnapshot,
} from "../shared/agent-definition";
import {
  buildControlPlaneReadiness,
  buildMetricsText,
} from "./control-plane-observability";

const NOW = "2026-07-21T12:00:00.000Z";

function baseSnapshot(): AgentControlPlaneSnapshot {
  return {
    version: 1,
    agents: [],
    revisions: [],
    triggers: [],
    lifecycleEvents: [],
    executions: [],
    queueEntries: [],
  };
}

describe("buildControlPlaneReadiness", () => {
  test("reports ready with stage and durable store state", () => {
    const status = buildControlPlaneReadiness({
      snapshot: baseSnapshot(),
      stage: "dry_run",
      storePath: "/var/lib/shipwright/agent-control-plane.json",
      now: NOW,
    });

    expect(status.ok).toBe(true);
    expect(status.stage).toBe("dry_run");
    expect(status.snapshotVersion).toBe(1);
  });

  test("fails closed when a schedule trigger is past due while the scheduler is active", () => {
    const snapshot = baseSnapshot();
    snapshot.agents.push(
      agentDefinitionSchema.parse({
        agentId: "agent-1",
        enabled: true,
        currentRevision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        health: { state: "idle" },
      }),
    );
    snapshot.revisions.push({
      agentId: "agent-1" as never,
      revision: 1,
      draft: {
        name: "Triage",
        instructions: "Prepare a dry run.",
        skillId: "fix-review-findings",
        allowedTools: ["github"],
        targetScope: { repository: "dallascrilley/shipwright" },
        verification: { presetId: "bun-test" },
        publicationPolicy: "dry_run",
      },
      createdAt: NOW,
    });
    snapshot.triggers.push({
      triggerId: "trigger-1",
      agentId: "agent-1" as never,
      agentRevision: 1,
      kind: "schedule",
      enabled: true,
      config: {
        schedule: "*/5 * * * *",
        timezone: "UTC",
        target: { kind: "issue", number: 1 },
      },
      nextFireAt: "2026-07-21T10:00:00.000Z",
      consecutiveFailures: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const status = buildControlPlaneReadiness({
      snapshot,
      stage: "dry_run",
      storePath: "/var/lib/shipwright/agent-control-plane.json",
      now: NOW,
    });

    expect(status.ok).toBe(false);
    expect(status.reasons.join(" ")).toContain("schedule");
  });
});

describe("buildMetricsText", () => {
  test("exposes only aggregate, redaction-safe counters and gauges", () => {
    const snapshot = baseSnapshot();
    snapshot.queueEntries.push({
      queueEntryId: "q1",
      executionId: "e1",
      agentId: "agent-1" as never,
      agentRevision: 1,
      state: "queued",
      scheduledAt: NOW,
      priority: 0,
      attempts: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    snapshot.queueEntries.push({
      queueEntryId: "q2",
      executionId: "e2",
      agentId: "agent-1" as never,
      agentRevision: 1,
      state: "dead_letter",
      scheduledAt: NOW,
      priority: 0,
      attempts: 3,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const text = buildMetricsText({
      snapshot,
      stage: "dry_run",
      now: NOW,
    });

    expect(text).toContain("shipwright_queue_entries{state=\"queued\"} 1");
    expect(text).toContain("shipwright_queue_entries{state=\"dead_letter\"} 1");
    expect(text).toContain("shipwright_rollout_stage{stage=\"dry_run\"} 1");
    expect(text).not.toContain("agent-1");
    expect(text).not.toContain("dallascrilley");
  });
});
