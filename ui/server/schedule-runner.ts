import {
  agentDefinitionSchema,
  agentTriggerSchema,
  type AgentControlPlaneSnapshot,
  type AgentDefinition,
  type AgentRevision,
  type AgentTrigger,
  type ExecutionRequest,
  type QueueEntry,
} from "../shared/agent-definition";
import { nextScheduleOccurrence } from "../shared/schedule";
import {
  appendLifecycleEvent,
  type AgentControlPlaneStore,
  AgentControlPlane,
} from "./agent-control-plane";
import { QueueDispatcher } from "./queue-dispatcher";

type ScheduleTrigger = AgentTrigger & {
  kind: "schedule";
  config: {
    schedule: string;
    timezone: string;
    target: { kind: ExecutionRequest["target"]["kind"]; number: number };
  };
  nextFireAt: string;
  consecutiveFailures: number;
};

type ScheduleTerminal = {
  trigger: ScheduleTrigger;
  execution: ExecutionRequest;
  entry: QueueEntry;
};

export type ScheduleSchedulerOptions = {
  maxDueTriggers: number;
  failureThreshold?: number;
};

export type ScheduleTickResult = {
  enqueued: number;
  skipped: number;
  reconciled: number;
};

/**
 * Transactional schedule scanner. Production wiring deliberately remains outside
 * this library until U6 provides a durable store and process ownership.
 */
export class ScheduleScheduler {
  readonly #failureThreshold: number;

  constructor(
    private readonly store: AgentControlPlaneStore,
    private readonly dispatcher: QueueDispatcher,
    private readonly createId: () => string,
    private readonly now: () => string,
    private readonly options: ScheduleSchedulerOptions,
  ) {
    if (
      !Number.isInteger(options.maxDueTriggers) ||
      options.maxDueTriggers < 1
    ) {
      throw new Error("Schedule scanner limit must be a positive integer.");
    }
    this.#failureThreshold = options.failureThreshold ?? 3;
    if (
      !Number.isInteger(this.#failureThreshold) ||
      this.#failureThreshold < 1
    ) {
      throw new Error("Schedule failure threshold must be a positive integer.");
    }
    this.dispatcher.onTerminal(() => this.reconcileTerminalOutcomes());
  }

  runDue(): ScheduleTickResult {
    return this.store.transaction((snapshot) => {
      const now = this.now();
      const reconciled = this.reconcileTerminalOutcomesInTransaction(
        snapshot,
        now,
      );
      const pausedAgentIds = new Set<string>();
      for (const agent of snapshot.agents) {
        if (agent.health.state === "paused") pausedAgentIds.add(agent.agentId);
      }
      const due = snapshot.triggers
        .flatMap((trigger) => {
          const scheduleTrigger = toScheduleTrigger(trigger);
          return scheduleTrigger &&
            scheduleTrigger.enabled &&
            !scheduleTrigger.pausedAt &&
            !pausedAgentIds.has(scheduleTrigger.agentId) &&
            Date.parse(scheduleTrigger.nextFireAt) <= Date.parse(now)
            ? [scheduleTrigger]
            : [];
        })
        .sort(
          (left, right) =>
            left.nextFireAt.localeCompare(right.nextFireAt) ||
            left.triggerId.localeCompare(right.triggerId),
        )
        .slice(0, this.options.maxDueTriggers);
      let enqueued = 0;
      let skipped = 0;

      for (const trigger of due) {
        const agent = this.requireAgent(snapshot, trigger.agentId);
        if (!agent.enabled) {
          this.replaceTrigger(snapshot, trigger, {
            ...trigger,
            nextFireAt: nextScheduleOccurrence(
              trigger.config.schedule,
              trigger.config.timezone,
              now,
            ),
            updatedAt: now,
          });
          appendLifecycleEvent(
            snapshot,
            this.createId,
            agent.agentId,
            "skipped",
            trigger.agentRevision,
            now,
            trigger.triggerId,
          );
          skipped += 1;
          continue;
        }

        const revision = this.requireRevision(
          snapshot,
          agent.agentId,
          trigger.agentRevision,
        );
        const occurrence = trigger.nextFireAt;
        this.dispatcher.enqueueInTransaction(snapshot, {
          agentId: agent.agentId,
          triggerId: trigger.triggerId,
          source: "schedule",
          idempotencyKey: `schedule:${trigger.triggerId}:${occurrence}`,
          target: targetForSchedule(revision, trigger),
          scheduledAt: occurrence,
        });
        this.replaceTrigger(snapshot, trigger, {
          ...trigger,
          nextFireAt: nextScheduleOccurrence(
            trigger.config.schedule,
            trigger.config.timezone,
            now,
          ),
          updatedAt: now,
        });
        appendLifecycleEvent(
          snapshot,
          this.createId,
          agent.agentId,
          "scheduled",
          trigger.agentRevision,
          now,
          trigger.triggerId,
        );
        enqueued += 1;
      }
      return { enqueued, skipped, reconciled };
    });
  }

  reconcileTerminalOutcomes(): number {
    return this.store.transaction((snapshot) =>
      this.reconcileTerminalOutcomesInTransaction(snapshot, this.now()),
    );
  }

  private reconcileTerminalOutcomesInTransaction(
    snapshot: AgentControlPlaneSnapshot,
    now: string,
  ): number {
    const outcomes = snapshot.triggers.flatMap((item) => {
      const trigger = toScheduleTrigger(item);
      if (!trigger) return [];
      const completed = snapshot.executions
        .filter((execution) => execution.triggerId === trigger.triggerId)
        .flatMap((execution) => {
          const entry = snapshot.queueEntries.find(
            (candidate) => candidate.executionId === execution.executionId,
          );
          return entry && isTerminal(entry)
            ? [{ trigger, execution, entry }]
            : [];
        })
        .sort(
          (left, right) =>
            left.entry.updatedAt.localeCompare(right.entry.updatedAt) ||
            left.execution.executionId.localeCompare(
              right.execution.executionId,
            ),
        );
      const processedIndex = trigger.lastOutcomeExecutionId
        ? completed.findIndex(
            (outcome) =>
              outcome.execution.executionId === trigger.lastOutcomeExecutionId,
          )
        : -1;
      return completed.slice(processedIndex + 1);
    });

    for (const outcome of outcomes) {
      this.applyScheduleOutcome(snapshot, outcome, now);
    }
    return outcomes.length;
  }

  private applyScheduleOutcome(
    snapshot: AgentControlPlaneSnapshot,
    outcome: ScheduleTerminal,
    now: string,
  ): void {
    const currentTrigger = this.requireScheduleTrigger(
      snapshot,
      outcome.trigger.triggerId,
    );
    const agent = this.requireAgent(snapshot, currentTrigger.agentId);
    const revision = this.requireRevision(
      snapshot,
      agent.agentId,
      currentTrigger.agentRevision,
    );
    const circuitOpen = agent.health.state === "paused";
    const failed =
      outcome.entry.state === "failed" ||
      outcome.entry.state === "interrupted" ||
      outcome.entry.state === "dead_letter";
    const consecutiveFailures = circuitOpen
      ? (agent.health.consecutiveScheduleFailures ?? 0)
      : failed
        ? (agent.health.consecutiveScheduleFailures ?? 0) + 1
        : 0;
    const threshold = revision.draft.failureThreshold ?? this.#failureThreshold;
    const opensCircuit =
      !circuitOpen && failed && consecutiveFailures >= threshold;
    if (!circuitOpen) {
      const nextAgent = agentDefinitionSchema.parse({
        ...agent,
        updatedAt: now,
        health: {
          ...agent.health,
          state: opensCircuit ? "paused" : failed ? "failed" : "idle",
          lastExecutionAt: now,
          lastOutcome: failed
            ? "failed"
            : outcome.entry.state === "cancelled"
              ? "cancelled"
              : "succeeded",
          consecutiveScheduleFailures: consecutiveFailures,
        },
      });
      snapshot.agents[snapshot.agents.indexOf(agent)] = nextAgent;
    }
    this.replaceTrigger(snapshot, currentTrigger, {
      ...currentTrigger,
      consecutiveFailures: circuitOpen
        ? failed
          ? currentTrigger.consecutiveFailures + 1
          : currentTrigger.consecutiveFailures
        : failed
          ? currentTrigger.consecutiveFailures + 1
          : 0,
      ...(opensCircuit ? { pausedAt: now } : {}),
      lastOutcomeExecutionId: outcome.execution.executionId,
      updatedAt: now,
    });
    if (opensCircuit) {
      appendLifecycleEvent(
        snapshot,
        this.createId,
        agent.agentId,
        "circuit_open",
        currentTrigger.agentRevision,
        now,
        currentTrigger.triggerId,
      );
    }
  }

  private requireAgent(
    snapshot: AgentControlPlaneSnapshot,
    agentId: string,
  ): AgentDefinition {
    const agent = snapshot.agents.find((item) => item.agentId === agentId);
    if (!agent) throw new Error(`Unknown schedule agent ${agentId}.`);
    return agent;
  }

  private requireRevision(
    snapshot: AgentControlPlaneSnapshot,
    agentId: string,
    revision: number,
  ): AgentRevision {
    const found = snapshot.revisions.find(
      (item) => item.agentId === agentId && item.revision === revision,
    );
    if (!found)
      throw new Error(
        `Missing schedule revision ${revision} for agent ${agentId}.`,
      );
    return found;
  }

  private requireScheduleTrigger(
    snapshot: AgentControlPlaneSnapshot,
    triggerId: string,
  ): ScheduleTrigger {
    const trigger = snapshot.triggers.find(
      (item) => item.triggerId === triggerId,
    );
    const scheduleTrigger = trigger ? toScheduleTrigger(trigger) : undefined;
    if (!scheduleTrigger)
      throw new Error(`Unknown schedule trigger ${triggerId}.`);
    return scheduleTrigger;
  }

  private replaceTrigger(
    snapshot: AgentControlPlaneSnapshot,
    current: ScheduleTrigger,
    next: ScheduleTrigger,
  ): ScheduleTrigger {
    const index = snapshot.triggers.indexOf(current);
    if (index < 0)
      throw new Error(`Unknown schedule trigger ${current.triggerId}.`);
    const parsed = agentTriggerSchema.parse(next);
    snapshot.triggers[index] = parsed;
    return toScheduleTrigger(parsed)!;
  }
}

export class ScheduleLifecycleService {
  constructor(
    private readonly store: AgentControlPlaneStore,
    private readonly controlPlane: AgentControlPlane,
    private readonly dispatcher: QueueDispatcher,
    private readonly createId: () => string,
    private readonly now: () => string,
  ) {}

  setEnabled(triggerId: string, enabled: boolean): AgentTrigger {
    return this.store.transaction((snapshot) => {
      const trigger = requireScheduleTrigger(snapshot, triggerId);
      if (trigger.enabled === enabled) return trigger;
      const now = this.now();
      const next = replaceScheduleTrigger(snapshot, trigger, {
        ...trigger,
        enabled,
        ...(enabled
          ? {
              nextFireAt: nextScheduleOccurrence(
                trigger.config.schedule,
                trigger.config.timezone,
                now,
              ),
            }
          : {}),
        updatedAt: now,
      });
      appendLifecycleEvent(
        snapshot,
        this.createId,
        next.agentId,
        enabled ? "enabled" : "disabled",
        next.agentRevision,
        now,
        next.triggerId,
      );
      return next;
    });
  }

  pause(triggerId: string): AgentTrigger {
    return this.store.transaction((snapshot) => {
      const trigger = requireScheduleTrigger(snapshot, triggerId);
      if (trigger.pausedAt) return trigger;
      const now = this.now();
      const next = replaceScheduleTrigger(snapshot, trigger, {
        ...trigger,
        pausedAt: now,
        updatedAt: now,
      });
      appendLifecycleEvent(
        snapshot,
        this.createId,
        next.agentId,
        "paused",
        next.agentRevision,
        now,
        next.triggerId,
      );
      return next;
    });
  }

  resume(triggerId: string): AgentTrigger {
    return this.store.transaction((snapshot) => {
      const trigger = requireScheduleTrigger(snapshot, triggerId);
      if (!trigger.pausedAt) return trigger;
      const now = this.now();
      const next = replaceScheduleTrigger(snapshot, trigger, {
        ...trigger,
        nextFireAt: nextScheduleOccurrence(
          trigger.config.schedule,
          trigger.config.timezone,
          now,
        ),
        consecutiveFailures: 0,
        pausedAt: undefined,
        updatedAt: now,
      });
      const agent = snapshot.agents.find(
        (item) => item.agentId === trigger.agentId,
      );
      if (agent) {
        snapshot.agents[snapshot.agents.indexOf(agent)] =
          agentDefinitionSchema.parse({
            ...agent,
            updatedAt: now,
            health: {
              ...agent.health,
              state: "idle",
              consecutiveScheduleFailures: 0,
            },
          });
      }
      appendLifecycleEvent(
        snapshot,
        this.createId,
        next.agentId,
        "resumed",
        next.agentRevision,
        now,
        next.triggerId,
      );
      return next;
    });
  }

  emergencyStop(agentId: string, expectedRevision: number): AgentDefinition {
    const now = this.now();
    const { agent, cancelled } = this.store.transaction((snapshot) => {
      const agent = this.controlPlane.setEnabledInTransaction(
        snapshot,
        agentId,
        expectedRevision,
        false,
        now,
      );
      const revision = snapshot.revisions.find(
        (item) =>
          item.agentId === agent.agentId &&
          item.revision === agent.currentRevision,
      );
      appendLifecycleEvent(
        snapshot,
        this.createId,
        agent.agentId,
        "stopped",
        agent.currentRevision,
        now,
      );
      const cancelled = this.dispatcher.cancelForAgentInTransaction(
        snapshot,
        agent.agentId,
        revision?.draft.cancelInFlight === true,
        now,
      );
      return { agent, cancelled };
    });
    this.dispatcher.abortCancelledEntries(cancelled);
    return agent;
  }

  retry(executionId: string): QueueEntry {
    const entry = this.dispatcher.retry(executionId);
    this.store.transaction((snapshot) => {
      const execution = snapshot.executions.find(
        (item) => item.executionId === executionId,
      );
      if (!execution?.triggerId) return;
      const trigger = snapshot.triggers.find(
        (item) => item.triggerId === execution.triggerId,
      );
      if (!trigger || !toScheduleTrigger(trigger)) return;
      appendLifecycleEvent(
        snapshot,
        this.createId,
        execution.agentId,
        "retry",
        execution.agentRevision,
        this.now(),
        execution.triggerId,
      );
    });
    return entry;
  }
}

function toScheduleTrigger(trigger: AgentTrigger): ScheduleTrigger | undefined {
  if (
    trigger.kind !== "schedule" ||
    !trigger.config ||
    !("schedule" in trigger.config) ||
    !trigger.nextFireAt ||
    trigger.consecutiveFailures === undefined
  ) {
    return undefined;
  }
  return trigger as ScheduleTrigger;
}

function requireScheduleTrigger(
  snapshot: AgentControlPlaneSnapshot,
  triggerId: string,
): ScheduleTrigger {
  const trigger = snapshot.triggers.find(
    (item) => item.triggerId === triggerId,
  );
  const scheduleTrigger = trigger ? toScheduleTrigger(trigger) : undefined;
  if (!scheduleTrigger)
    throw new Error(`Unknown schedule trigger ${triggerId}.`);
  return scheduleTrigger;
}

function replaceScheduleTrigger(
  snapshot: AgentControlPlaneSnapshot,
  current: ScheduleTrigger,
  next: ScheduleTrigger,
): ScheduleTrigger {
  const index = snapshot.triggers.indexOf(current);
  if (index < 0)
    throw new Error(`Unknown schedule trigger ${current.triggerId}.`);
  const parsed = agentTriggerSchema.parse(next);
  snapshot.triggers[index] = parsed;
  return toScheduleTrigger(parsed)!;
}

function targetForSchedule(
  revision: AgentRevision,
  trigger: ScheduleTrigger,
): ExecutionRequest["target"] {
  const [owner, repo] = revision.draft.targetScope.repository.split("/", 2);
  return {
    kind: trigger.config.target.kind,
    owner: owner!,
    repo: repo!,
    number: trigger.config.target.number,
  };
}

function isTerminal(entry: QueueEntry): boolean {
  return [
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
    "dead_letter",
  ].includes(entry.state);
}
