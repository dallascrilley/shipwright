import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  agentControlPlaneSnapshotSchema,
  agentDefinitionSchema,
  agentDraftSchema,
  agentRevisionSchema,
  agentTriggerSchema,
  createEmptyAgentControlPlaneSnapshot,
  curatedGithubTriggerConfigSchema,
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
import { nextScheduleOccurrence } from "../shared/schedule";

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

/**
 * Single-process durable transactional store. A complete schema-validated
 * snapshot is atomically renamed into place, so a restart observes either the
 * prior snapshot or the committed replacement, never a partial write.
 */
export class JsonFileAgentControlPlaneStore
  implements AgentControlPlaneStore
{
  constructor(private readonly path: string) {}

  load(): AgentControlPlaneSnapshot {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      return structuredClone(agentControlPlaneSnapshotSchema.parse(parsed));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return createEmptyAgentControlPlaneSnapshot();
      }
      throw new Error(
        `could not load agent control-plane state at ${this.path}`,
        { cause: error },
      );
    }
  }

  transaction<Result>(
    operation: (snapshot: AgentControlPlaneSnapshot) => Result,
  ): Result {
    const candidate = structuredClone(this.load());
    const result = operation(candidate);
    const snapshot = agentControlPlaneSnapshotSchema.parse(candidate);
    this.save(snapshot);
    return structuredClone(result);
  }

  private save(snapshot: AgentControlPlaneSnapshot): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporaryPath = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, this.path);
    chmodSync(this.path, 0o600);
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

export type CreateTriggerInput = Pick<AgentTriggerInput, "kind" | "config"> & {
  agentId: string;
  expectedRevision: number;
};

export interface RemoveTriggerInput {
  agentId: string;
  expectedRevision: number;
  triggerId: string;
}

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
        this.appendEvent(
          snapshot,
          next.agentId,
          "policy_changed",
          revision,
          now,
        );
      }
      return next;
    });
  }

  setEnabled(
    agentId: string,
    expectedRevision: number,
    enabled: boolean,
  ): AgentDefinition {
    return this.store.transaction((snapshot) =>
      this.setEnabledInTransaction(
        snapshot,
        agentId,
        expectedRevision,
        enabled,
      ),
    );
  }

  setEnabledInTransaction(
    snapshot: AgentControlPlaneSnapshot,
    agentId: string,
    expectedRevision: number,
    enabled: boolean,
    now = this.now(),
  ): AgentDefinition {
    const agent = this.requireAgent(snapshot, agentId);
    this.assertRevision(agent, expectedRevision);
    if (agent.enabled === enabled) return agent;
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
  }

  createTrigger(input: CreateTriggerInput): AgentTrigger {
    return this.store.transaction((snapshot) => {
      const agent = this.requireAgent(snapshot, input.agentId);
      this.assertRevision(agent, input.expectedRevision);
      if (input.kind === "github") {
        curatedGithubTriggerConfigSchema.parse(input.config);
      }
      const now = this.now();
      const scheduleConfig =
        input.kind === "schedule" && "schedule" in input.config
          ? input.config
          : undefined;
      const trigger = agentTriggerSchema.parse({
        triggerId: this.createId(),
        agentId: agent.agentId,
        agentRevision: agent.currentRevision,
        kind: input.kind,
        enabled: true,
        config: input.config,
        ...(scheduleConfig
          ? {
              nextFireAt: nextScheduleOccurrence(
                scheduleConfig.schedule,
                scheduleConfig.timezone,
                now,
              ),
              consecutiveFailures: 0,
            }
          : {}),
        createdAt: now,
        updatedAt: now,
      });
      snapshot.triggers.push(trigger);
      return trigger;
    });
  }

  removeTrigger(input: RemoveTriggerInput): AgentTrigger {
    return this.store.transaction((snapshot) => {
      const agent = this.requireAgent(snapshot, input.agentId);
      this.assertRevision(agent, input.expectedRevision);
      const triggerIndex = snapshot.triggers.findIndex(
        (trigger) =>
          trigger.agentId === agent.agentId &&
          trigger.triggerId === input.triggerId,
      );
      if (triggerIndex < 0) {
        throw new Error(
          `Unknown trigger ${input.triggerId} for agent ${agent.agentId}.`,
        );
      }
      const [removed] = snapshot.triggers.splice(triggerIndex, 1);
      if (!removed) {
        throw new Error(`Could not remove trigger ${input.triggerId}.`);
      }
      this.appendEvent(
        snapshot,
        agent.agentId,
        "trigger_removed",
        agent.currentRevision,
        this.now(),
        removed.triggerId,
      );
      return removed;
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
    if (!found)
      throw new Error(`Missing revision ${revision} for agent ${agentId}.`);
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
    triggerId?: string,
  ): void {
    appendLifecycleEvent(
      snapshot,
      this.createId,
      agentId,
      action,
      revision,
      occurredAt,
      triggerId,
    );
  }
}

export function appendLifecycleEvent(
  snapshot: AgentControlPlaneSnapshot,
  createId: () => string,
  agentId: AgentDefinition["agentId"],
  action: LifecycleEvent["action"],
  revision: number,
  occurredAt: string,
  triggerId?: string,
): void {
  const sequence =
    snapshot.lifecycleEvents.reduce(
      (highest, event) => Math.max(highest, event.sequence),
      0,
    ) + 1;
  snapshot.lifecycleEvents.push(
    lifecycleEventSchema.parse({
      eventId: createId(),
      agentId,
      action,
      ...(triggerId ? { triggerId } : {}),
      revision,
      sequence,
      occurredAt,
    }),
  );
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
