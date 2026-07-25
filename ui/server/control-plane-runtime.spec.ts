import { describe, expect, test, vi } from "vitest";

import type { AgentDefinition } from "../shared/agent-definition";
import {
  MemoryAgentControlPlaneStore,
  type AgentControlPlaneStore,
} from "./agent-control-plane";
import {
  canPublishAtStage,
  resolveRolloutStage,
  sourcesDispatchableAtStage,
} from "./control-plane-runtime";
import { QueueDispatcher } from "./queue-dispatcher";

describe("rollout stages", () => {
  test("defaults to disabled and rejects unknown stage values", () => {
    expect(resolveRolloutStage({})).toBe("disabled");
    expect(resolveRolloutStage({ SHIPWRIGHT_ROLLOUT_STAGE: "test_only" })).toBe(
      "test_only",
    );
    expect(() =>
      resolveRolloutStage({ SHIPWRIGHT_ROLLOUT_STAGE: "yolo" }),
    ).toThrow("SHIPWRIGHT_ROLLOUT_STAGE");
  });

  test("dispatchable sources expand with the rollout stage", () => {
    expect(sourcesDispatchableAtStage("disabled")).toEqual([]);
    expect(sourcesDispatchableAtStage("test_only")).toEqual(["test"]);
    expect(sourcesDispatchableAtStage("dry_run")).toEqual([
      "test",
      "github",
      "schedule",
    ]);
  });

  test("publication requires the publish stage and a publish-allowed revision", () => {
    const stages = [
      "disabled",
      "test_only",
      "dry_run",
      "approval_required",
      "publish_allowed",
    ] as const;
    const policies = ["dry_run", "approval_required", "publish_allowed"] as const;
    for (const stage of stages) {
      for (const policy of policies) {
        const allowed =
          stage === "publish_allowed" && policy === "publish_allowed";
        expect(canPublishAtStage(stage, policy)).toBe(allowed);
      }
    }
  });
});

describe("QueueDispatcher rollout gating", () => {
  const draft = {
    name: "Issue triage",
    instructions: "Triage allowlisted issues and prepare a dry run.",
    actionPreset: "resolve_pr_feedback" as const,
    skillId: "fix-review-findings",
    allowedTools: ["github", "sandbox"],
    targetScope: { repository: "dallascrilley/shipwright" },
    verification: { presetId: "bun-test" },
    publicationPolicy: "dry_run" as const,
  };

  function setup(): {
    store: AgentControlPlaneStore;
    dispatcher: QueueDispatcher;
  } {
    const store = new MemoryAgentControlPlaneStore();
    let id = 0;
    const dispatcher = new QueueDispatcher(
      store,
      () => `id-${++id}`,
      () => "2026-07-21T00:00:00.000Z",
      {
        leaseDurationMs: 60_000,
        globalConcurrency: 4,
        perAgentConcurrency: 4,
        failureThreshold: 3,
      },
    );
    return { store, dispatcher };
  }

  test("claims only entries whose source the rollout stage dispatches", () => {
    const { store, dispatcher } = setup();
    store.transaction((snapshot) => {
      const agentId = "agent-1" as AgentDefinition["agentId"];
      snapshot.agents.push({
        agentId,
        enabled: true,
        currentRevision: 1,
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
        health: { state: "idle" },
      });
      snapshot.revisions.push({
        agentId,
        revision: 1,
        draft,
        createdAt: "2026-07-21T00:00:00.000Z",
      });
    });
    const target = {
      kind: "issue" as const,
      owner: "dallascrilley",
      repo: "shipwright",
      number: 42,
    };
    dispatcher.enqueue({
      agentId: "agent-1" as AgentDefinition["agentId"],
      source: "schedule",
      idempotencyKey: "schedule:1",
      target,
    });
    dispatcher.enqueue({
      agentId: "agent-1" as AgentDefinition["agentId"],
      source: "test",
      idempotencyKey: "test:1",
      target,
    });

    const claim = dispatcher.claimNext("worker-1", ["test"]);

    expect(claim?.execution.idempotencyKey).toBe("test:1");
  });
});
