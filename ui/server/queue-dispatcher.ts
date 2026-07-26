import {
  executionRequestSchema,
  queueEntrySchema,
  type AgentControlPlaneSnapshot,
  type AgentDefinition,
  type AgentRevision,
  type ExecutionRequest,
  type ExecutionRequestInput,
  targetMatchesScope,
  type QueueEntry,
} from "../shared/agent-definition";
import type { AgentControlPlaneStore } from "./agent-control-plane";

export interface QueueDispatcherOptions {
  leaseDurationMs: number;
  globalConcurrency: number;
  perAgentConcurrency: number;
  failureThreshold: number;
}

export interface QueueEnqueueInput {
  agentId: string;
  triggerId?: string;
  source: ExecutionRequestInput["source"];
  idempotencyKey: string;
  target: ExecutionRequestInput["target"];
  scheduledAt?: string;
  priority?: number;
  /**
   * When true, return an existing queued/claimed/running execution for the same
   * agent revision and target instead of enqueueing a second wake. Used by
   * review-comment bursts so N deliveries collapse to one in-flight run.
   */
  coalesceInFlight?: boolean;
  /** UI-only dry-run proof may be queued before activation. Never honor for trigger traffic. */
  allowDisabledAgentForTest?: boolean;
}

const IN_FLIGHT_QUEUE_STATES: Partial<Record<QueueEntry["state"], true>> = {
  queued: true,
  claimed: true,
  running: true,
};

export interface QueueEnqueueResult {
  execution: ExecutionRequest;
  entry: QueueEntry;
}

export interface QueueClaim {
  execution: ExecutionRequest;
  revision: AgentRevision;
  entry: QueueEntry;
}

export interface QueueRunContext extends QueueClaim {
  signal: AbortSignal;
}

export interface QueueRunResult {
  receipt: NonNullable<QueueEntry["receipt"]>;
}

export type QueueRunner = (context: QueueRunContext) => Promise<QueueRunResult>;

const TERMINAL_STATES: Partial<Record<QueueEntry["state"], true>> = {
  succeeded: true,
  failed: true,
  cancelled: true,
  interrupted: true,
  dead_letter: true,
};

/**
 * Durable queue state machine. The store transaction is the only claim boundary;
 * runners receive immutable execution and revision snapshots after a lease is held.
 */
export class QueueDispatcher {
  readonly #controllers = new Map<string, AbortController>();
  readonly #terminalListeners = new Set<() => void>();

  constructor(
    private readonly store: AgentControlPlaneStore,
    private readonly createId: () => string,
    private readonly now: () => string,
    private readonly options: QueueDispatcherOptions,
  ) {
    if (
      !Number.isInteger(options.leaseDurationMs) ||
      options.leaseDurationMs < 1 ||
      !Number.isInteger(options.globalConcurrency) ||
      options.globalConcurrency < 1 ||
      !Number.isInteger(options.perAgentConcurrency) ||
      options.perAgentConcurrency < 1 ||
      !Number.isInteger(options.failureThreshold) ||
      options.failureThreshold < 1
    ) {
      throw new Error("Queue dispatcher options must be positive integers.");
    }
  }

  onTerminal(listener: () => void): () => void {
    this.#terminalListeners.add(listener);
    return () => this.#terminalListeners.delete(listener);
  }

  enqueue(input: QueueEnqueueInput): QueueEnqueueResult {
    return this.store.transaction((snapshot) =>
      this.enqueueInTransaction(snapshot, input),
    );
  }

  /** Caller owns the surrounding store transaction and its atomic commit. */
  enqueueInTransaction(
    snapshot: AgentControlPlaneSnapshot,
    input: QueueEnqueueInput,
  ): QueueEnqueueResult {
    const agent = this.requireAgent(snapshot, input.agentId);
    const isExplicitDisabledAgentTest =
      input.source === "test" && input.allowDisabledAgentForTest === true;
    if (!agent.enabled && !isExplicitDisabledAgentTest) {
      throw new Error(
        `Agent ${agent.agentId} is disabled and cannot enqueue work.`,
      );
    }
    const trigger = input.triggerId
      ? snapshot.triggers.find((item) => item.triggerId === input.triggerId)
      : undefined;
    if (input.triggerId && (!trigger || trigger.agentId !== agent.agentId)) {
      throw new Error(
        `Unknown trigger ${input.triggerId} for agent ${agent.agentId}.`,
      );
    }
    if (trigger && !trigger.enabled) {
      throw new Error(
        `Trigger ${trigger.triggerId} is disabled and cannot enqueue work.`,
      );
    }
    const agentRevision = trigger?.agentRevision ?? agent.currentRevision;
    const revision = this.requireRevision(
      snapshot,
      agent.agentId,
      agentRevision,
    );
    if (!targetMatchesScope(input.target, revision.draft.targetScope)) {
      throw new Error(
        `Target is outside agent ${agent.agentId} repository scope.`,
      );
    }
    const existing = snapshot.executions.find(
      (execution) =>
        execution.agentId === agent.agentId &&
        execution.agentRevision === agentRevision &&
        execution.idempotencyKey === input.idempotencyKey,
    );
    if (existing) {
      return {
        execution: existing,
        entry: this.requireEntry(snapshot, existing.executionId),
      };
    }
    if (input.coalesceInFlight) {
      const inFlight = snapshot.executions.find((execution) => {
        if (
          execution.agentId !== agent.agentId ||
          execution.agentRevision !== agentRevision ||
          !sameExecutionTarget(execution.target, input.target)
        ) {
          return false;
        }
        const entry = snapshot.queueEntries.find(
          (item) => item.executionId === execution.executionId,
        );
        return Boolean(entry && IN_FLIGHT_QUEUE_STATES[entry.state]);
      });
      if (inFlight) {
        return {
          execution: inFlight,
          entry: this.requireEntry(snapshot, inFlight.executionId),
        };
      }
    }

    const now = this.now();
    const execution = executionRequestSchema.parse({
      executionId: this.createId(),
      agentId: agent.agentId,
      agentRevision,
      ...(trigger ? { triggerId: trigger.triggerId } : {}),
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      target: input.target,
      scheduledAt: input.scheduledAt ?? now,
      priority: input.priority ?? 0,
      createdAt: now,
    });
    const entry = queueEntrySchema.parse({
      queueEntryId: this.createId(),
      executionId: execution.executionId,
      agentId: execution.agentId,
      agentRevision: execution.agentRevision,
      state: "queued",
      scheduledAt: execution.scheduledAt,
      priority: execution.priority,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    snapshot.executions.push(execution);
    snapshot.queueEntries.push(entry);
    return { execution, entry };
  }

  claimNext(
    owner: string,
    sources?: readonly ExecutionRequest["source"][],
  ): QueueClaim | undefined {
    if (sources && sources.length === 0) return undefined;
    this.recoverExpiredLeases();
    return this.store.transaction((snapshot) => {
      const now = this.now();
      const nowTime = Date.parse(now);
      const active = snapshot.queueEntries.filter(
        (entry) => entry.state === "claimed" || entry.state === "running",
      );
      if (active.length >= this.options.globalConcurrency) return undefined;

      const candidate = snapshot.queueEntries
        .filter(
          (entry) =>
            entry.state === "queued" &&
            Date.parse(entry.scheduledAt) <= nowTime &&
            snapshot.agents.some(
              (agent) =>
                agent.agentId === entry.agentId &&
                (agent.enabled || entrySource(snapshot, entry) === "test") &&
                agent.health.state !== "paused",
            ),
        )
        .sort(
          (left, right) =>
            right.priority - left.priority ||
            left.scheduledAt.localeCompare(right.scheduledAt) ||
            left.queueEntryId.localeCompare(right.queueEntryId),
        )
        .find(
          (entry) =>
            (!sources ||
              sources.some(
                (source) => source === entrySource(snapshot, entry),
              )) &&
            active.filter((item) => item.agentId === entry.agentId).length <
              this.options.perAgentConcurrency,
        );
      if (!candidate) return undefined;

      const lease = {
        leaseId: this.createId(),
        owner,
        expiresAt: new Date(
          nowTime + this.options.leaseDurationMs,
        ).toISOString(),
      };
      const claimed = this.replaceEntry(snapshot, candidate, {
        ...candidate,
        state: "claimed",
        attempts: candidate.attempts + 1,
        lease,
        updatedAt: now,
      });
      return this.toClaim(snapshot, claimed);
    });
  }

  async dispatchNext(
    owner: string,
    runner: QueueRunner,
    sources?: readonly ExecutionRequest["source"][],
  ): Promise<QueueEntry | undefined> {
    const claim = this.claimNext(owner, sources);
    if (!claim || !claim.entry.lease) return undefined;

    const controller = new AbortController();
    this.#controllers.set(claim.execution.executionId, controller);
    const running = this.markRunning(
      claim.execution.executionId,
      claim.entry.lease.leaseId,
    );
    if (!running) {
      this.#controllers.delete(claim.execution.executionId);
      return this.get(claim.execution.executionId);
    }
    try {
      const result = await runner({
        ...claim,
        entry: running,
        signal: controller.signal,
      });
      const state = result.receipt.verificationPassed
        ? "succeeded"
        : this.nextFailureState(running.attempts);
      return this.finish(
        claim.execution.executionId,
        claim.entry.lease.leaseId,
        state,
        result.receipt,
        result.receipt.verificationPassed
          ? undefined
          : (result.receipt.errorCode ?? "verification_failed"),
      );
    } catch {
      if (controller.signal.aborted) {
        return this.get(claim.execution.executionId);
      }
      return this.finish(
        claim.execution.executionId,
        claim.entry.lease.leaseId,
        this.nextFailureState(running.attempts),
        undefined,
        "runner_failed",
      );
    } finally {
      this.#controllers.delete(claim.execution.executionId);
    }
  }

  cancel(executionId: string): QueueEntry {
    const cancelled = this.store.transaction((snapshot) => {
      const current = this.requireEntry(snapshot, executionId);
      if (TERMINAL_STATES[current.state]) return current;
      return this.replaceEntry(snapshot, current, {
        ...this.withoutLease(current),
        state: "cancelled",
        updatedAt: this.now(),
      });
    });
    this.#controllers
      .get(executionId)
      ?.abort(new Error("Run cancelled by operator."));
    this.notifyTerminal();
    return cancelled;
  }

  cancelForAgent(agentId: string, cancelLeaseHeld: boolean): QueueEntry[] {
    const cancelled = this.store.transaction((snapshot) =>
      this.cancelForAgentInTransaction(snapshot, agentId, cancelLeaseHeld),
    );
    this.abortCancelledEntries(cancelled);
    return cancelled;
  }

  cancelForAgentInTransaction(
    snapshot: AgentControlPlaneSnapshot,
    agentId: string,
    cancelLeaseHeld: boolean,
    now = this.now(),
  ): QueueEntry[] {
    return snapshot.queueEntries
      .filter(
        (entry) =>
          entry.agentId === agentId &&
          !TERMINAL_STATES[entry.state] &&
          (cancelLeaseHeld || entry.state === "queued"),
      )
      .map((entry) =>
        this.replaceEntry(snapshot, entry, {
          ...this.withoutLease(entry),
          state: "cancelled",
          updatedAt: now,
        }),
      );
  }

  abortCancelledEntries(entries: readonly QueueEntry[]): void {
    for (const entry of entries) {
      this.#controllers
        .get(entry.executionId)
        ?.abort(new Error("Run cancelled by operator."));
    }
    if (entries.length > 0) this.notifyTerminal();
  }

  recoverExpiredLeases(): QueueEntry[] {
    const expired = this.store.transaction((snapshot) => {
      const now = this.now();
      const nowTime = Date.parse(now);
      return snapshot.queueEntries.flatMap((entry) => {
        if (
          (entry.state !== "claimed" && entry.state !== "running") ||
          !entry.lease ||
          Date.parse(entry.lease.expiresAt) > nowTime
        ) {
          return [];
        }
        return [
          this.replaceEntry(snapshot, entry, {
            ...this.withoutLease(entry),
            state: "interrupted",
            updatedAt: now,
          }),
        ];
      });
    });
    for (const entry of expired) {
      this.#controllers
        .get(entry.executionId)
        ?.abort(new Error("Queue lease expired before completion."));
    }
    if (expired.length > 0) this.notifyTerminal();
    return expired;
  }

  retry(executionId: string): QueueEntry {
    return this.store.transaction((snapshot) => {
      const current = this.requireEntry(snapshot, executionId);
      if (current.state !== "failed" && current.state !== "interrupted") {
        throw new Error(`Execution ${executionId} is not retryable.`);
      }
      if (current.attempts >= this.options.failureThreshold) {
        throw new Error(
          `Execution ${executionId} reached the dead-letter threshold.`,
        );
      }
      return this.replaceEntry(snapshot, current, {
        ...this.withoutLease(current),
        state: "queued",
        failureCode: undefined,
        receipt: undefined,
        scheduledAt: this.now(),
        updatedAt: this.now(),
      });
    });
  }

  get(executionId: string): QueueEntry | undefined {
    return this.store
      .load()
      .queueEntries.find((entry) => entry.executionId === executionId);
  }

  list(): QueueEntry[] {
    return this.store.load().queueEntries;
  }

  private markRunning(
    executionId: string,
    leaseId: string,
  ): QueueEntry | undefined {
    return this.store.transaction((snapshot) => {
      const current = this.requireEntry(snapshot, executionId);
      if (current.state !== "claimed" || current.lease?.leaseId !== leaseId) {
        return undefined;
      }
      return this.replaceEntry(snapshot, current, {
        ...current,
        state: "running",
        updatedAt: this.now(),
      });
    });
  }

  private finish(
    executionId: string,
    leaseId: string,
    state: "succeeded" | "failed" | "dead_letter",
    receipt?: QueueRunResult["receipt"],
    failureCode?: string,
  ): QueueEntry {
    const finished = this.store.transaction((snapshot) => {
      const current = this.requireEntry(snapshot, executionId);
      if (
        (current.state !== "claimed" && current.state !== "running") ||
        current.lease?.leaseId !== leaseId
      ) {
        return current;
      }
      return this.replaceEntry(snapshot, current, {
        ...this.withoutLease(current),
        state,
        ...(receipt ? { receipt } : {}),
        ...(failureCode ? { failureCode } : {}),
        updatedAt: this.now(),
      });
    });
    if (TERMINAL_STATES[finished.state]) this.notifyTerminal();
    return finished;
  }

  private notifyTerminal(): void {
    for (const listener of this.#terminalListeners) listener();
  }

  private nextFailureState(attempts: number): "failed" | "dead_letter" {
    return attempts >= this.options.failureThreshold ? "dead_letter" : "failed";
  }

  private toClaim(
    snapshot: AgentControlPlaneSnapshot,
    entry: QueueEntry,
  ): QueueClaim {
    const execution = snapshot.executions.find(
      (item) => item.executionId === entry.executionId,
    );
    if (!execution) throw new Error(`Missing execution ${entry.executionId}.`);
    const revision = this.requireRevision(
      snapshot,
      execution.agentId,
      execution.agentRevision,
    );
    return { execution, revision, entry };
  }

  private requireAgent(
    snapshot: AgentControlPlaneSnapshot,
    agentId: string,
  ): AgentDefinition {
    const agent = snapshot.agents.find((item) => item.agentId === agentId);
    if (!agent) throw new Error(`Unknown agent ${agentId}.`);
    return agent;
  }

  private requireEntry(
    snapshot: AgentControlPlaneSnapshot,
    executionId: string,
  ): QueueEntry {
    const entry = snapshot.queueEntries.find(
      (item) => item.executionId === executionId,
    );
    if (!entry) throw new Error(`Unknown execution ${executionId}.`);
    return entry;
  }

  private requireRevision(
    snapshot: AgentControlPlaneSnapshot,
    agentId: string,
    revision: number,
  ): AgentRevision {
    const found = snapshot.revisions.find(
      (item) => item.agentId === agentId && item.revision === revision,
    );
    if (!found) {
      throw new Error(`Missing revision ${revision} for agent ${agentId}.`);
    }
    return found;
  }

  private replaceEntry(
    snapshot: AgentControlPlaneSnapshot,
    current: QueueEntry,
    next: QueueEntry,
  ): QueueEntry {
    const index = snapshot.queueEntries.findIndex(
      (item) => item.executionId === current.executionId,
    );
    if (index < 0) throw new Error(`Unknown execution ${current.executionId}.`);
    const parsed = queueEntrySchema.parse(next);
    snapshot.queueEntries[index] = parsed;
    return parsed;
  }

  private withoutLease(entry: QueueEntry): Omit<QueueEntry, "lease"> {
    const { lease: _lease, ...withoutLease } = entry;
    return withoutLease;
  }
}

/** Queue entries carry no source; resolve it from the parent execution. */
function entrySource(
  snapshot: AgentControlPlaneSnapshot,
  entry: QueueEntry,
): ExecutionRequest["source"] | undefined {
  return snapshot.executions.find(
    (execution) => execution.executionId === entry.executionId,
  )?.source;
}

function sameExecutionTarget(
  left: ExecutionRequest["target"],
  right: ExecutionRequestInput["target"],
): boolean {
  return (
    left.kind === right.kind &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase() &&
    left.number === right.number
  );
}
