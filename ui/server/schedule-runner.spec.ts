import { describe, expect, test } from "vitest";

import {
  AgentControlPlane,
  MemoryAgentControlPlaneStore,
} from "./agent-control-plane";
import { QueueDispatcher } from "./queue-dispatcher";
import { ScheduleLifecycleService, ScheduleScheduler } from "./schedule-runner";

function createFixture({ concurrency = 1 }: { concurrency?: number } = {}) {
  let id = 0;
  let now = "2026-07-21T08:55:00.000Z";
  const createId = () => `id-${++id}`;
  const store = new MemoryAgentControlPlaneStore();
  const controlPlane = new AgentControlPlane(store, createId, () => now);
  const dispatcher = new QueueDispatcher(store, createId, () => now, {
    leaseDurationMs: 1_000,
    globalConcurrency: concurrency,
    perAgentConcurrency: concurrency,
    failureThreshold: 5,
  });
  const scheduler = new ScheduleScheduler(
    store,
    dispatcher,
    createId,
    () => now,
    {
      maxDueTriggers: 10,
    },
  );
  const lifecycle = new ScheduleLifecycleService(
    store,
    controlPlane,
    dispatcher,
    createId,
    () => now,
  );
  const agent = controlPlane.createAgent({
    name: "Scheduled triage",
    instructions: "Triage one scheduled issue in a dry run.",
    actionPreset: "fix_issue",
    skillId: "",
    allowedTools: ["github"],
    targetScope: { repository: "dallascrilley/shipwright", branch: "main" },
    verification: { presetId: "bun-test" },
    publicationPolicy: "dry_run",
    failureThreshold: 2,
    cancelInFlight: true,
  });
  controlPlane.setEnabled(agent.agentId, agent.currentRevision, true);
  const trigger = controlPlane.createTrigger({
    agentId: agent.agentId,
    expectedRevision: agent.currentRevision,
    kind: "schedule",
    config: {
      schedule: "*/5 * * * *",
      timezone: "UTC",
      target: { kind: "issue", number: 42 },
    },
  });

  return {
    agent,
    controlPlane,
    dispatcher,
    lifecycle,
    scheduler,
    setNow(value: string) {
      now = value;
    },
    store,
    trigger,
  };
}

describe("ScheduleScheduler", () => {
  test("enqueues each due occurrence once and advances its persisted cursor", () => {
    const fixture = createFixture();
    fixture.setNow("2026-07-21T09:00:00.000Z");

    expect(fixture.scheduler.runDue()).toMatchObject({
      enqueued: 1,
      skipped: 0,
    });
    expect(fixture.scheduler.runDue()).toMatchObject({
      enqueued: 0,
      skipped: 0,
    });
    expect(fixture.dispatcher.list()).toMatchObject([
      {
        state: "queued",
        scheduledAt: "2026-07-21T09:00:00.000Z",
      },
    ]);
    expect(fixture.store.load().triggers[0]).toMatchObject({
      nextFireAt: "2026-07-21T09:05:00.000Z",
    });
  });

  test("enqueues one overdue occurrence after a restart and skips the remaining backlog", () => {
    const fixture = createFixture();
    fixture.setNow("2026-07-21T09:23:00.000Z");

    expect(fixture.scheduler.runDue()).toMatchObject({
      enqueued: 1,
      skipped: 0,
    });
    expect(fixture.dispatcher.list()[0]).toMatchObject({
      scheduledAt: "2026-07-21T09:00:00.000Z",
    });
    expect(fixture.store.load().triggers[0]).toMatchObject({
      nextFireAt: "2026-07-21T09:25:00.000Z",
    });
  });

  test("skips a due occurrence after disable and advances past downtime", () => {
    const fixture = createFixture();
    fixture.controlPlane.setEnabled(
      fixture.agent.agentId,
      fixture.agent.currentRevision,
      false,
    );
    fixture.setNow("2026-07-21T09:00:00.000Z");

    expect(fixture.scheduler.runDue()).toMatchObject({
      enqueued: 0,
      skipped: 1,
    });
    expect(fixture.dispatcher.list()).toEqual([]);
    expect(fixture.store.load().triggers[0]?.nextFireAt).toBe(
      "2026-07-21T09:05:00.000Z",
    );
  });

  test("does not claim already queued schedule work after an agent is disabled", () => {
    const fixture = createFixture();
    fixture.setNow("2026-07-21T09:00:00.000Z");
    fixture.scheduler.runDue();
    fixture.controlPlane.setEnabled(
      fixture.agent.agentId,
      fixture.agent.currentRevision,
      false,
    );

    expect(fixture.dispatcher.claimNext("worker-1")).toBeUndefined();
    expect(fixture.dispatcher.list()[0]).toMatchObject({ state: "queued" });
  });

  test("does not schedule disabled triggers until an explicit re-enable", () => {
    const fixture = createFixture();
    fixture.lifecycle.setEnabled(fixture.trigger.triggerId, false);
    fixture.setNow("2026-07-21T09:00:00.000Z");

    expect(fixture.scheduler.runDue()).toMatchObject({
      enqueued: 0,
      skipped: 0,
    });
    fixture.lifecycle.setEnabled(fixture.trigger.triggerId, true);
    fixture.setNow("2026-07-21T09:05:00.000Z");

    expect(fixture.scheduler.runDue()).toMatchObject({
      enqueued: 1,
      skipped: 0,
    });
    expect(
      fixture.controlPlane.listLifecycleEvents(fixture.agent.agentId),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "disabled",
          triggerId: fixture.trigger.triggerId,
        }),
        expect.objectContaining({
          action: "enabled",
          triggerId: fixture.trigger.triggerId,
        }),
      ]),
    );
  });

  test("makes trigger enable transitions idempotent and validates the trigger", () => {
    const fixture = createFixture();

    expect(
      fixture.lifecycle.setEnabled(fixture.trigger.triggerId, false),
    ).toMatchObject({
      enabled: false,
    });
    expect(
      fixture.lifecycle.setEnabled(fixture.trigger.triggerId, false),
    ).toMatchObject({
      enabled: false,
    });
    expect(
      fixture.controlPlane
        .listLifecycleEvents(fixture.agent.agentId)
        .filter((event) => event.action === "disabled"),
    ).toHaveLength(1);
    expect(() => fixture.lifecycle.setEnabled("missing-trigger", true)).toThrow(
      "Unknown schedule trigger missing-trigger.",
    );
  });

  test("keeps a per-agent circuit open until an operator resumes it", async () => {
    const fixture = createFixture({ concurrency: 2 });
    fixture.setNow("2026-07-21T09:00:00.000Z");
    fixture.scheduler.runDue();
    await fixture.dispatcher.dispatchNext("worker-1", async () => ({
      receipt: {
        runId: "run-1",
        phase: "complete",
        verificationPassed: false,
        errorCode: "verification_failed",
      },
    }));

    fixture.setNow("2026-07-21T09:05:00.000Z");
    fixture.controlPlane.createTrigger({
      agentId: fixture.agent.agentId,
      expectedRevision: fixture.agent.currentRevision,
      kind: "schedule",
      config: {
        schedule: "*/5 * * * *",
        timezone: "UTC",
        target: { kind: "issue", number: 43 },
      },
    });
    fixture.dispatcher.enqueue({
      agentId: fixture.agent.agentId,
      triggerId: fixture.trigger.triggerId,
      source: "test",
      idempotencyKey: "in-flight-before-circuit",
      target: {
        kind: "issue",
        owner: "dallascrilley",
        repo: "shipwright",
        number: 44,
      },
    });
    fixture.scheduler.runDue();

    let completeInFlight:
      | ((result: {
          receipt: {
            runId: string;
            phase: "complete";
            verificationPassed: boolean;
          };
        }) => void)
      | undefined;
    const inFlight = fixture.dispatcher.dispatchNext(
      "worker-in-flight",
      async () =>
        new Promise((resolve) => {
          completeInFlight = resolve;
        }),
    );
    await Promise.resolve();
    fixture.dispatcher.enqueue({
      agentId: fixture.agent.agentId,
      triggerId: fixture.trigger.triggerId,
      source: "test",
      idempotencyKey: "queued-after-circuit",
      target: {
        kind: "issue",
        owner: "dallascrilley",
        repo: "shipwright",
        number: 45,
      },
    });
    await fixture.dispatcher.dispatchNext("worker-1", async () => ({
      receipt: {
        runId: "run-2",
        phase: "complete",
        verificationPassed: false,
        errorCode: "verification_failed",
      },
    }));
    expect(
      fixture.dispatcher.claimNext("worker-before-reconcile"),
    ).toBeUndefined();

    fixture.setNow("2026-07-21T09:10:00.000Z");
    expect(fixture.scheduler.runDue()).toMatchObject({ enqueued: 0 });
    if (!completeInFlight) throw new Error("In-flight runner did not start.");
    completeInFlight({
      receipt: {
        runId: "run-in-flight",
        phase: "complete",
        verificationPassed: true,
      },
    });
    await inFlight;
    expect(fixture.scheduler.runDue()).toMatchObject({ enqueued: 0 });
    expect(fixture.dispatcher.claimNext("worker-2")).toBeUndefined();
    expect(fixture.controlPlane.getAgent(fixture.agent.agentId)).toMatchObject({
      health: { state: "paused", consecutiveScheduleFailures: 2 },
    });
    expect(fixture.store.load().triggers[0]).toMatchObject({
      pausedAt: "2026-07-21T09:05:00.000Z",
      consecutiveFailures: 2,
    });
    expect(fixture.lifecycle.resume(fixture.trigger.triggerId)).toMatchObject({
      pausedAt: undefined,
      consecutiveFailures: 0,
    });
  });

  test("counts an expired schedule lease as a non-success outcome", () => {
    const fixture = createFixture();
    fixture.setNow("2026-07-21T09:00:00.000Z");
    fixture.scheduler.runDue();
    expect(fixture.dispatcher.claimNext("worker-1")).toBeDefined();

    fixture.setNow("2026-07-21T09:01:00.000Z");
    expect(fixture.dispatcher.recoverExpiredLeases()).toHaveLength(1);
    fixture.scheduler.runDue();

    expect(fixture.controlPlane.getAgent(fixture.agent.agentId)).toMatchObject({
      health: {
        state: "failed",
        lastOutcome: "failed",
        consecutiveScheduleFailures: 1,
      },
    });
    expect(fixture.store.load().triggers[0]).toMatchObject({
      consecutiveFailures: 1,
    });
  });

  test("records pause, resume, and retry lifecycle decisions", async () => {
    const fixture = createFixture();
    fixture.setNow("2026-07-21T09:00:00.000Z");
    fixture.lifecycle.pause(fixture.trigger.triggerId);
    expect(fixture.scheduler.runDue()).toMatchObject({
      enqueued: 0,
      skipped: 0,
    });
    fixture.lifecycle.resume(fixture.trigger.triggerId);
    fixture.lifecycle.resume(fixture.trigger.triggerId);
    expect(
      fixture.controlPlane
        .listLifecycleEvents(fixture.agent.agentId)
        .filter((event) => event.action === "resumed"),
    ).toHaveLength(1);
    fixture.setNow("2026-07-21T09:05:00.000Z");
    fixture.scheduler.runDue();
    const failed = await fixture.dispatcher.dispatchNext(
      "worker-1",
      async () => ({
        receipt: {
          runId: "run-1",
          phase: "complete",
          verificationPassed: false,
          errorCode: "verification_failed",
        },
      }),
    );

    fixture.lifecycle.retry(failed!.executionId);

    expect(
      fixture.controlPlane
        .listLifecycleEvents(fixture.agent.agentId)
        .map((event) => event.action),
    ).toEqual(
      expect.arrayContaining(["paused", "resumed", "scheduled", "retry"]),
    );
  });

  test("emergency stop disables an agent and cancels its lease-held work when permitted", () => {
    const fixture = createFixture();
    fixture.setNow("2026-07-21T09:00:00.000Z");
    fixture.scheduler.runDue();
    const claimed = fixture.dispatcher.claimNext("worker-1");
    expect(claimed?.entry.state).toBe("claimed");

    fixture.lifecycle.emergencyStop(
      fixture.agent.agentId,
      fixture.agent.currentRevision,
    );

    expect(fixture.controlPlane.getAgent(fixture.agent.agentId)).toMatchObject({
      enabled: false,
    });
    expect(fixture.dispatcher.list()[0]).toMatchObject({ state: "cancelled" });
    expect(
      fixture.controlPlane
        .listLifecycleEvents(fixture.agent.agentId)
        .map((event) => event.action),
    ).toContain("stopped");
  });
});
