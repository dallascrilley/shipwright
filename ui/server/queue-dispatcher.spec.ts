import { describe, expect, test } from "vitest";

import type { AgentDraftInput } from "../shared/agent-definition";
import {
  AgentControlPlane,
  MemoryAgentControlPlaneStore,
} from "./agent-control-plane";
import { QueueDispatcher, type QueueRunner } from "./queue-dispatcher";

const draft: AgentDraftInput = {
  name: "Issue triage",
  instructions: "Triage allowlisted issues and prepare a dry run.",
  skillId: "fix-review-findings",
  allowedTools: ["github", "sandbox"],
  targetScope: { repository: "dallascrilley/shipwright", branch: "main" },
  verification: { presetId: "bun-test" },
  publicationPolicy: "dry_run" as const,
};

interface QueueFixtureOptions {
  globalConcurrency?: number;
  perAgentConcurrency?: number;
  failureThreshold?: number;
}

interface TestClock {
  now(): string;
  advance(milliseconds: number): void;
}

interface QueueFixture {
  clock: TestClock;
  store: MemoryAgentControlPlaneStore;
  controlPlane: AgentControlPlane;
  dispatcher: QueueDispatcher;
}

function createClock(): TestClock {
  let value = new Date("2026-07-21T00:00:00.000Z");
  return {
    now: () => value.toISOString(),
    advance(milliseconds: number) {
      value = new Date(value.getTime() + milliseconds);
    },
  };
}

function createFixture(options?: QueueFixtureOptions): QueueFixture {
  const clock = createClock();
  const store = new MemoryAgentControlPlaneStore();
  let agentIds = 0;
  let queueIds = 0;
  const controlPlane = new AgentControlPlane(
    store,
    () => `agent-${++agentIds}`,
    clock.now,
  );
  const dispatcher = new QueueDispatcher(
    store,
    () => `queue-${++queueIds}`,
    clock.now,
    {
      leaseDurationMs: 1_000,
      globalConcurrency: options?.globalConcurrency ?? 1,
      perAgentConcurrency: options?.perAgentConcurrency ?? 1,
      failureThreshold: options?.failureThreshold ?? 3,
    },
  );
  return { clock, store, controlPlane, dispatcher };
}

function createEnabledAgent(
  fixture: QueueFixture,
  overrides: Partial<typeof draft> = {},
) {
  const agent = fixture.controlPlane.createAgent({ ...draft, ...overrides });
  fixture.controlPlane.setEnabled(agent.agentId, agent.currentRevision, true);
  return agent;
}

function enqueue(
  fixture: QueueFixture,
  agentId: string,
  idempotencyKey: string,
) {
  return fixture.dispatcher.enqueue({
    agentId,
    source: "test",
    idempotencyKey,
    target: {
      kind: "issue",
      owner: "dallascrilley",
      repo: "shipwright",
      number: 42,
    },
  });
}

const succeeds: QueueRunner = async ({ execution }) => ({
  receipt: {
    runId: execution.executionId,
    phase: "complete",
    verificationPassed: true,
  },
});

describe("QueueDispatcher", () => {
  test("deduplicates an event before it invokes the pinned runner", async () => {
    const fixture = createFixture();
    const agent = createEnabledAgent(fixture);
    const first = enqueue(fixture, agent.agentId, "github:delivery-1");
    const duplicate = enqueue(fixture, agent.agentId, "github:delivery-1");
    let invocations = 0;
    const runner: QueueRunner = async (context) => {
      invocations += 1;
      return succeeds(context);
    };

    await fixture.dispatcher.dispatchNext("worker-a", runner);
    await fixture.dispatcher.dispatchNext("worker-b", runner);

    expect(duplicate).toEqual(first);
    expect(fixture.dispatcher.list()).toHaveLength(1);
    expect(first.execution.agentRevision).toBe(1);
    expect(fixture.dispatcher.get(first.execution.executionId)).toMatchObject({
      state: "succeeded",
    });
    expect(invocations).toBe(1);
  });

  test("coalesces in-flight pull targets while preserving delivery idempotency keys", () => {
    const fixture = createFixture();
    const agent = createEnabledAgent(fixture);
    const target = {
      kind: "pull" as const,
      owner: "dallascrilley",
      repo: "shipwright",
      number: 19,
    };
    const first = fixture.dispatcher.enqueue({
      agentId: agent.agentId,
      source: "github",
      idempotencyKey: "github:delivery-comment-a:1",
      target,
      coalesceInFlight: true,
    });
    const coalesced = fixture.dispatcher.enqueue({
      agentId: agent.agentId,
      source: "github",
      idempotencyKey: "github:delivery-comment-b:1",
      target,
      coalesceInFlight: true,
    });

    expect(coalesced.execution.executionId).toBe(first.execution.executionId);
    expect(coalesced.execution.idempotencyKey).toBe(
      "github:delivery-comment-a:1",
    );
    expect(fixture.dispatcher.list()).toHaveLength(1);
  });

  test("rejects disabled agents and disabled triggers before enqueueing", () => {
    const fixture = createFixture();
    const agent = fixture.controlPlane.createAgent(draft);

    expect(() =>
      enqueue(fixture, agent.agentId, "test:disabled-agent"),
    ).toThrow(/disabled/);
    expect(() =>
      fixture.dispatcher.enqueue({
        agentId: agent.agentId,
        source: "github",
        allowDisabledAgentForTest: true,
        idempotencyKey: "github:cannot-bypass-disabled-agent",
        target: {
          kind: "issue",
          owner: "dallascrilley",
          repo: "shipwright",
          number: 42,
        },
      }),
    ).toThrow(/disabled/);
    fixture.controlPlane.setEnabled(agent.agentId, 1, true);
    const trigger = fixture.controlPlane.createTrigger({
      agentId: agent.agentId,
      expectedRevision: 1,
      kind: "github",
      config: { event: "issues", actions: ["opened"] },
    });
    fixture.store.transaction((snapshot) => {
      const stored = snapshot.triggers.find(
        (item) => item.triggerId === trigger.triggerId,
      );
      if (!stored) throw new Error("missing trigger");
      stored.enabled = false;
    });

    expect(() =>
      fixture.dispatcher.enqueue({
        agentId: agent.agentId,
        triggerId: trigger.triggerId,
        source: "test",
        idempotencyKey: "test:disabled-trigger",
        target: {
          kind: "issue",
          owner: "dallascrilley",
          repo: "shipwright",
          number: 42,
        },
      }),
    ).toThrow(/trigger .*disabled/i);
    expect(fixture.dispatcher.list()).toEqual([]);
  });

  test("rejects a target outside the pinned revision repository scope", () => {
    const fixture = createFixture();
    const agent = createEnabledAgent(fixture);

    expect(() =>
      fixture.dispatcher.enqueue({
        agentId: agent.agentId,
        source: "test",
        idempotencyKey: "test:foreign-target",
        target: {
          kind: "issue",
          owner: "dallascrilley",
          repo: "other-repository",
          number: 42,
        },
      }),
    ).toThrow(/outside agent .*repository scope/i);
    expect(fixture.dispatcher.list()).toEqual([]);
  });

  test("records a resolved verification failure as failed", async () => {
    const fixture = createFixture();
    const agent = createEnabledAgent(fixture);
    const queued = enqueue(fixture, agent.agentId, "test:verification-failed");

    const completed = await fixture.dispatcher.dispatchNext(
      "worker-a",
      async ({ execution }) => ({
        receipt: {
          runId: execution.executionId,
          phase: "verify",
          verificationPassed: false,
          errorCode: "verification_failed",
        },
      }),
    );

    expect(completed).toMatchObject({
      executionId: queued.execution.executionId,
      state: "failed",
      failureCode: "verification_failed",
      receipt: { verificationPassed: false },
    });
  });

  test("allows one transactional claimer for one execution", () => {
    const fixture = createFixture({ globalConcurrency: 2 });
    const agent = createEnabledAgent(fixture);
    enqueue(fixture, agent.agentId, "github:delivery-1");

    const first = fixture.dispatcher.claimNext("worker-a");
    const second = fixture.dispatcher.claimNext("worker-b");

    expect(first?.entry.state).toBe("claimed");
    expect(first?.entry.lease?.owner).toBe("worker-a");
    expect(second).toBeUndefined();
  });

  test("enforces both global and per-agent concurrency limits", () => {
    const perAgent = createFixture({
      globalConcurrency: 2,
      perAgentConcurrency: 1,
    });
    const agent = createEnabledAgent(perAgent);
    enqueue(perAgent, agent.agentId, "test:one");
    enqueue(perAgent, agent.agentId, "test:two");
    expect(perAgent.dispatcher.claimNext("worker-a")).toBeDefined();
    expect(perAgent.dispatcher.claimNext("worker-b")).toBeUndefined();

    const global = createFixture({
      globalConcurrency: 1,
      perAgentConcurrency: 2,
    });
    const firstAgent = createEnabledAgent(global);
    const secondAgent = createEnabledAgent(global);
    enqueue(global, firstAgent.agentId, "test:one");
    enqueue(global, secondAgent.agentId, "test:two");
    expect(global.dispatcher.claimNext("worker-a")).toBeDefined();
    expect(global.dispatcher.claimNext("worker-b")).toBeUndefined();
  });

  test("marks a running lease interrupted after restart and requires retry", async () => {
    const fixture = createFixture();
    const agent = createEnabledAgent(fixture);
    const queued = enqueue(
      fixture,
      agent.agentId,
      "schedule:2026-07-21T00:00:00Z",
    );
    let finishRun: () => void = () => undefined;
    const runner: QueueRunner = ({ execution }) =>
      new Promise((resolve) => {
        finishRun = () =>
          resolve({
            receipt: {
              runId: execution.executionId,
              phase: "complete",
              verificationPassed: true,
            },
          });
      });
    const running = fixture.dispatcher.dispatchNext("worker-a", runner);
    await Promise.resolve();
    const restarted = new QueueDispatcher(
      fixture.store,
      () => "restart-lease",
      fixture.clock.now,
      {
        leaseDurationMs: 1_000,
        globalConcurrency: 1,
        perAgentConcurrency: 1,
        failureThreshold: 3,
      },
    );

    fixture.clock.advance(1_001);
    expect(restarted.recoverExpiredLeases()).toMatchObject([
      { executionId: queued.execution.executionId, state: "interrupted" },
    ]);
    expect(await restarted.dispatchNext("worker-b", succeeds)).toBeUndefined();

    finishRun();
    await running;
    expect(restarted.get(queued.execution.executionId)?.state).toBe(
      "interrupted",
    );

    restarted.retry(queued.execution.executionId);
    expect(await restarted.dispatchNext("worker-b", succeeds)).toMatchObject({
      state: "succeeded",
    });
  });

  test("cancels an active runner through AbortSignal without publishing", async () => {
    const fixture = createFixture();
    const agent = createEnabledAgent(fixture);
    const queued = enqueue(fixture, agent.agentId, "test:cancel");
    let sawAbort = false;
    const runner: QueueRunner = async ({ signal }) => {
      const { promise, reject } = Promise.withResolvers<never>();
      signal.addEventListener(
        "abort",
        () => {
          sawAbort = true;
          reject(signal.reason);
        },
        { once: true },
      );
      return promise;
    };

    const running = fixture.dispatcher.dispatchNext("worker-a", runner);
    const cancelled = fixture.dispatcher.cancel(queued.execution.executionId);
    await running;

    expect(sawAbort).toBe(true);
    expect(cancelled.state).toBe("cancelled");
    expect(
      fixture.dispatcher.get(queued.execution.executionId)?.receipt,
    ).toBeUndefined();
  });

  test("dead-letters repeated explicit failures without automatic reruns", async () => {
    const fixture = createFixture({ failureThreshold: 3 });
    const agent = createEnabledAgent(fixture);
    const queued = enqueue(fixture, agent.agentId, "test:failures");
    const fails: QueueRunner = async () => {
      throw new Error("runner failure");
    };

    await fixture.dispatcher.dispatchNext("worker-a", fails);
    expect(fixture.dispatcher.get(queued.execution.executionId)).toMatchObject({
      state: "failed",
      attempts: 1,
    });
    fixture.dispatcher.retry(queued.execution.executionId);
    await fixture.dispatcher.dispatchNext("worker-a", fails);
    fixture.dispatcher.retry(queued.execution.executionId);
    await fixture.dispatcher.dispatchNext("worker-a", fails);

    expect(fixture.dispatcher.get(queued.execution.executionId)).toMatchObject({
      state: "dead_letter",
      attempts: 3,
      failureCode: "runner_failed",
    });
  });

  test("passes the pinned publication policy unchanged to the runner and records a receipt", async () => {
    const fixture = createFixture();
    const agent = createEnabledAgent(fixture, {
      publicationPolicy: "publish_allowed",
    });
    const queued = enqueue(fixture, agent.agentId, "test:policy");
    let observedPolicy = "";
    const runner: QueueRunner = async (context) => {
      observedPolicy = context.revision.draft.publicationPolicy;
      return succeeds(context);
    };

    await fixture.dispatcher.dispatchNext("worker-a", runner);

    expect(observedPolicy).toBe("publish_allowed");
    expect(fixture.dispatcher.get(queued.execution.executionId)).toMatchObject({
      state: "succeeded",
      receipt: {
        verificationPassed: true,
      },
    });
  });
});
