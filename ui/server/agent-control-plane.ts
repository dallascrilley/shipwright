import {
  agentControlPlaneSnapshotSchema,
  agentDefinitionSchema,
  agentDraftSchema,
  agentRevisionSchema,
  agentTriggerSchema,
  createEmptyAgentControlPlaneSnapshot,
  lifecycleEventSchema,
  type AgentControlPlaneSnapshot,
  type AgentDefinition,
  type AgentDraftInput,
  type AgentRevision,
  type AgentTrigger,
  type AgentTriggerInput,
  type LifecycleEvent,
  type QueueEntry,
} from "../shared/agent-definition";
import type { OperatorRunRecord } from "../shared/operator-run";

export interface AgentControlPlaneStore {
  load(): AgentControlPlaneSnapshot;
  transaction<Result>(
    operation: (snapshot: AgentControlPlaneSnapshot) => Result,
  ): Result;
}

/** In-memory transactional store for U1; the production durable adapter lands before triggers. */
export class MemoryAgentControlPlaneStore implements AgentControlPlaneStore {
  #snapshot: AgentControlPlaneSnapshot;

  constructor(snapshot = createEmptyAgentControlPlaneSnapshot()) {
    this.#snapshot = agentControlPlaneSnapshotSchema.parse(snapshot);
  }

  load(): AgentControlPlaneSnapshot {
    return structuredClone(this.#snapshot);
  }

  transaction<Result>(
    operation: (snapshot: AgentControlPlaneSnapshot) => Result,
  ): Result {
    const candidate = structuredClone(this.#snapshot);
    const result = operation(candidate);
    this.#snapshot = agentControlPlaneSnapshotSchema.parse(candidate);
    return structuredClone(result);
  }
}

export class RevisionConflictError extends Error {
  constructor(
    readonly agentId: string,
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `Agent ${agentId} changed from revision ${expectedRevision} to ${currentRevision}. Refresh before saving.`,
    );
    this.name = "RevisionConflictError";
  }
}

export type CreateTriggerInput = Pick<
  AgentTriggerInput,
  "kind" | "config"
> & {
  agentId: string;
  expectedRevision: number;
};


/**
 * State transitions for durable agent definitions. This class has no dispatcher or
 * trigger activation path; U2 owns claiming and executing the queue.
 */
export class AgentControlPlane {
  constructor(
    private readonly store: AgentControlPlaneStore,
    private readonly createId: () => string,
    private readonly now: () => string,
  ) {}

  createAgent(input: AgentDraftInput): AgentDefinition {
    const draft = agentDraftSchema.parse(input);
    return this.store.transaction((snapshot) => {
      const now = this.now();
      const agent = agentDefinitionSchema.parse({
        agentId: this.createId(),
        currentRevision: 1,
        enabled: false,
        createdAt: now,
        updatedAt: now,
        health: { state: "idle" },
      });
      const revision = agentRevisionSchema.parse({
        agentId: agent.agentId,
        revision: 1,
        createdAt: now,
        draft,
      });
      snapshot.agents.push(agent);
      snapshot.revisions.push(revision);
      this.appendEvent(snapshot, agent.agentId, "created", 1, now);
      return agent;
    });
  }

  updateAgent(
    agentId: string,
    expectedRevision: number,
    input: AgentDraftInput,
  ): AgentDefinition {
    const draft = agentDraftSchema.parse(input);
    return this.store.transaction((snapshot) => {
      const agent = this.requireAgent(snapshot, agentId);
      this.assertRevision(agent, expectedRevision);
      const previous = this.requireRevision(
        snapshot,
        agent.agentId,
        agent.currentRevision,
      );
      const now = this.now();
      const revision = agent.currentRevision + 1;
      const nextRevision = agentRevisionSchema.parse({
        agentId: agent.agentId,
        revision,
        createdAt: now,
        draft,
      });
      const next = agentDefinitionSchema.parse({
        ...agent,
        currentRevision: revision,
        updatedAt: now,
      });
      snapshot.revisions.push(nextRevision);
      snapshot.agents[snapshot.agents.indexOf(agent)] = next;
      this.appendEvent(snapshot, next.agentId, "updated", revision, now);
      if (previous.draft.publicationPolicy !== draft.publicationPolicy) {
        this.appendEvent(snapshot, next.agentId, "policy_changed", revision, now);
      }
      return next;
    });
  }

  setEnabled(
    agentId: string,
    expectedRevision: number,
    enabled: boolean,
  ): AgentDefinition {
    return this.store.transaction((snapshot) => {
      const agent = this.requireAgent(snapshot, agentId);
      this.assertRevision(agent, expectedRevision);
      if (agent.enabled === enabled) return agent;
      const now = this.now();
      const next = agentDefinitionSchema.parse({
        ...agent,
        enabled,
        updatedAt: now,
      });
      snapshot.agents[snapshot.agents.indexOf(agent)] = next;
      this.appendEvent(
        snapshot,
        next.agentId,
        enabled ? "enabled" : "disabled",
        next.currentRevision,
        now,
      );
      return next;
    });
  }

  createTrigger(input: CreateTriggerInput): AgentTrigger {
    return this.store.transaction((snapshot) => {
      const agent = this.requireAgent(snapshot, input.agentId);
      this.assertRevision(agent, input.expectedRevision);
      const now = this.now();
      const trigger = agentTriggerSchema.parse({
        triggerId: this.createId(),
        agentId: agent.agentId,
        agentRevision: agent.currentRevision,
        kind: input.kind,
        enabled: true,
        config: input.config,
        createdAt: now,
        updatedAt: now,
      });
      snapshot.triggers.push(trigger);
      return trigger;
    });
  }


  getAgent(agentId: string): AgentDefinition | undefined {
    return this.store.load().agents.find((agent) => agent.agentId === agentId);
  }

  getRevision(agentId: string, revision: number): AgentRevision | undefined {
    return this.store
      .load()
      .revisions.find(
        (item) => item.agentId === agentId && item.revision === revision,
      );
  }

  listLifecycleEvents(agentId: string): LifecycleEvent[] {
    return this.store
      .load()
      .lifecycleEvents.filter((event) => event.agentId === agentId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  listQueueEntries(): QueueEntry[] {
    return this.store.load().queueEntries;
  }

  private requireAgent(
    snapshot: AgentControlPlaneSnapshot,
    agentId: string,
  ): AgentDefinition {
    const agent = snapshot.agents.find((item) => item.agentId === agentId);
    if (!agent) throw new Error(`Unknown agent ${agentId}.`);
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
    if (!found) throw new Error(`Missing revision ${revision} for agent ${agentId}.`);
    return found;
  }

  private assertRevision(
    agent: AgentDefinition,
    expectedRevision: number,
  ): void {
    if (agent.currentRevision !== expectedRevision) {
      throw new RevisionConflictError(
        agent.agentId,
        expectedRevision,
        agent.currentRevision,
      );
    }
  }

  private appendEvent(
    snapshot: AgentControlPlaneSnapshot,
    agentId: AgentDefinition["agentId"],
    action: LifecycleEvent["action"],
    revision: number,
    occurredAt: string,
  ): void {
    const sequence =
      snapshot.lifecycleEvents.reduce(
        (highest, event) => Math.max(highest, event.sequence),
        0,
      ) + 1;
    snapshot.lifecycleEvents.push(
      lifecycleEventSchema.parse({
        eventId: this.createId(),
        agentId,
        action,
        revision,
        sequence,
        occurredAt,
      }),
    );
  }
}

/**
 * P0 history was not created by an agent and remains valid without a link.
 * Clone records during migration so future callers cannot mutate persisted history.
 */
export function migrateLegacyOperatorRuns(
  records: readonly OperatorRunRecord[],
): OperatorRunRecord[] {
  return records.map((record) => {
    const migrated = structuredClone(record);
    if (
      typeof migrated.agentId !== "string" ||
      !Number.isInteger(migrated.agentRevision) ||
      (migrated.agentRevision ?? 0) < 1
    ) {
      delete migrated.agentId;
      delete migrated.agentRevision;
    }
    return migrated;
  });
}
