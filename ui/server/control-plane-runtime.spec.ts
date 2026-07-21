import {
  MemoryAgentControlPlaneStore,
  type AgentControlPlaneStore,
} from "./agent-control-plane";
import type { AgentDefinition } from "../shared/agent-definition";
import {
  canPublishAtStage,
  resolveRolloutStage,
  sourcesDispatchableAtStage,
} from "./control-plane-runtime";
import { QueueDispatcher } from "./queue-dispatcher";
import { describe, expect, test, vi } from "vitest";

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
    expect(canPublishAtStage("disabled", "publish_allowed")).toBe(false);
    expect(canPublishAtStage("approval_required", "publish_allowed")).toBe(
      false,
    );
    expect(canPublishAtStage("publish_allowed", "approval_required")).toBe(
      false,
    );
    expect(canPublishAtStage("publish_allowed", "publish_allowed")).toBe(true);
  });
});

describe("QueueDispatcher rollout gating", () => {
  const draft = {
    name: "Issue triage",
    instructions: "Triage allowlisted issues and prepare a dry run.",
    skillId: "fix-review-findings",
    allowedTools: ["github", "sandbox"],
    targetScope: { repository: "dallascrilley/shipwright" },
    verification: { presetId: "bun-test" },
    publicationPolicy: "dry_run" as const,
  };

  function setup(): { store: AgentControlPlaneStore; dispatcher: QueueDispatcher } {
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
