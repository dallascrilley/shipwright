import { afterEach, describe, expect, test } from "vitest";

import {
  AgentControlPlane,
  MemoryAgentControlPlaneStore,
} from "./agent-control-plane";
import { QueueDispatcher } from "./queue-dispatcher";
import { operatorPipelineQueueRunner } from "./queue-runner";

// guard:allow-env-credential — test-only non-secret demo mode switch
const originalDemoMode = process.env.SHIPWRIGHT_UI_DEMO;

afterEach(() => {
  if (originalDemoMode === undefined) {
    delete process.env.SHIPWRIGHT_UI_DEMO;
  } else {
    process.env.SHIPWRIGHT_UI_DEMO = originalDemoMode;
  }
});

function createQueuedDemoRun() {
  const now = () => "2026-07-21T00:00:00.000Z";
  const store = new MemoryAgentControlPlaneStore();
  let id = 0;
  const controlPlane = new AgentControlPlane(store, () => `id-${++id}`, now);
  const dispatcher = new QueueDispatcher(store, () => `id-${++id}`, now, {
    leaseDurationMs: 1_000,
    globalConcurrency: 1,
    perAgentConcurrency: 1,
    failureThreshold: 3,
  });
  const agent = controlPlane.createAgent({
    name: "Demo issue triage",
    instructions: "Prepare a dry run.",
    skillId: "fix-review-findings",
    allowedTools: ["github", "sandbox"],
    targetScope: { repository: "dallascrilley/shipwright", branch: "main" },
    verification: { presetId: "bun-test" },
    publicationPolicy: "dry_run",
  });
  controlPlane.setEnabled(agent.agentId, agent.currentRevision, true);
  const queued = dispatcher.enqueue({
    agentId: agent.agentId,
    source: "test",
    idempotencyKey: "test:demo",
    target: {
      kind: "issue",
      owner: "dallascrilley",
      repo: "shipwright",
      number: 42,
    },
  });
  return { store, dispatcher, queued };
}

describe("operatorPipelineQueueRunner", () => {
  test("dispatches a queued dry-run demo and records its pipeline receipt", async () => {
    process.env.SHIPWRIGHT_UI_DEMO = "1";
    const { dispatcher, queued } = createQueuedDemoRun();

    const completed = await dispatcher.dispatchNext(
      "demo-worker",
      operatorPipelineQueueRunner,
    );

    expect(completed).toMatchObject({
      executionId: queued.execution.executionId,
      state: "succeeded",
      receipt: {
        runId: queued.execution.executionId,
        phase: "complete",
        verificationPassed: true,
      },
    });
  });

  test("fails a tampered execution that no longer matches its pinned scope", async () => {
    const { store, dispatcher, queued } = createQueuedDemoRun();
    store.transaction((snapshot) => {
      const execution = snapshot.executions.find(
        (item) => item.executionId === queued.execution.executionId,
      );
      if (!execution) throw new Error("missing execution");
      execution.target.repo = "other-repository";
    });

    const failed = await dispatcher.dispatchNext(
      "demo-worker",
      operatorPipelineQueueRunner,
    );

    expect(failed).toMatchObject({
      executionId: queued.execution.executionId,
      state: "failed",
      failureCode: "target_scope_violation",
      receipt: { verificationPassed: false },
    });
  });
});
