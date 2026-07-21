import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { resolveShipwrightStateDirectory } from "../../src/config/state.js";

import {
  agentDraftSchema,
  agentTriggerSchema,
  type AgentControlPlaneSnapshot,
  type AgentDefinition,
  type AgentDraftInput,
  type AgentTrigger,
  type ExecutionRequest,
  type QueueEntry,
} from "../shared/agent-definition";
import {
  agentListFilterSchema,
  buildAgentDetail,
  buildAgentList,
  type AgentDetailView,
  type AgentListFilter,
  type AgentListItem,
} from "../shared/agent-management";
import type { OperatorRunRecord } from "../shared/operator-run";
import {
  AgentControlPlane,
  JsonFileAgentControlPlaneStore,
  MemoryAgentControlPlaneStore,
  type AgentControlPlaneStore,
  type CreateTriggerInput,
} from "./agent-control-plane";
import { getOperatorRunRegistry, isOperatorDemoMode } from "./operator-runs";
import {
  ControlPlaneRuntime,
  resolveRolloutStage,
} from "./control-plane-runtime";
import { QueueDispatcher } from "./queue-dispatcher";
import { operatorPipelineQueueRunner } from "./queue-runner";
import { ScheduleLifecycleService, ScheduleScheduler } from "./schedule-runner";

export interface AgentManagementDependencies {
  store?: AgentControlPlaneStore;
  createId?: () => string;
  now?: () => string;
  operatorRuns?: () => readonly OperatorRunRecord[];
}

export interface AgentRevisionSaveInput {
  agentId: string;
  expectedRevision: number;
  draft: AgentDraftInput;
}

export interface AgentEnableInput {
  agentId: string;
  expectedRevision: number;
  enabled: boolean;
}

export interface AgentTestRunInput {
  agentId: string;
  expectedRevision: number;
  target: {
    kind: "issue" | "pull";
    number: number;
  };
}

export const DEFAULT_LEASE_DURATION_MS = 60_000;

/** UI-facing control-plane boundary over the durable U6 store. */
export class AgentManagementService {
  readonly #store: AgentControlPlaneStore;
  readonly #controlPlane: AgentControlPlane;
  readonly #dispatcher: QueueDispatcher;
  readonly #lifecycle: ScheduleLifecycleService;
  readonly #createId: () => string;
  readonly #now: () => string;
  readonly #operatorRuns: () => readonly OperatorRunRecord[];

  constructor(dependencies: AgentManagementDependencies = {}) {
    this.#store = dependencies.store ?? createDefaultControlPlaneStore();
    this.#createId =
      dependencies.createId ?? (() => randomBytes(8).toString("hex"));
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#operatorRuns =
      dependencies.operatorRuns ?? (() => getOperatorRunRegistry().list(200));
    this.#controlPlane = new AgentControlPlane(
      this.#store,
      this.#createId,
      this.#now,
    );
    this.#dispatcher = new QueueDispatcher(
      this.#store,
      this.#createId,
      this.#now,
      {
        leaseDurationMs: DEFAULT_LEASE_DURATION_MS,
        globalConcurrency: 1,
        perAgentConcurrency: 1,
        failureThreshold: 3,
      },
    );
    this.#lifecycle = new ScheduleLifecycleService(
      this.#store,
      this.#controlPlane,
      this.#dispatcher,
      this.#createId,
      this.#now,
    );
  }

  createAgent(input: AgentDraftInput): AgentDefinition {
    return this.#controlPlane.createAgent(agentDraftSchema.parse(input));
  }

  saveAgent(input: AgentRevisionSaveInput): AgentDefinition {
    return this.#controlPlane.updateAgent(
      input.agentId,
      input.expectedRevision,
      agentDraftSchema.parse(input.draft),
    );
  }

  createTrigger(input: CreateTriggerInput): AgentTrigger {
    return this.#controlPlane.createTrigger(input);
  }

  setAgentEnabled(input: AgentEnableInput): AgentDefinition {
    if (input.enabled) this.assertEnabledTrigger(input.agentId);
    return this.#controlPlane.setEnabled(
      input.agentId,
      input.expectedRevision,
      input.enabled,
    );
  }

  pauseScheduleTrigger(triggerId: string): AgentTrigger {
    return this.#lifecycle.pause(triggerId);
  }

  resumeScheduleTrigger(triggerId: string): AgentTrigger {
    return this.#lifecycle.resume(triggerId);
  }

  emergencyStop(input: Omit<AgentEnableInput, "enabled">): AgentDefinition {
    return this.#lifecycle.emergencyStop(input.agentId, input.expectedRevision);
  }

  queueTestRun(input: AgentTestRunInput): {
    execution: ExecutionRequest;
    entry: QueueEntry;
  } {
    const snapshot = this.#store.load();
    const agent = requireAgent(snapshot, input.agentId);
    if (agent.currentRevision !== input.expectedRevision) {
      throw new Error(
        `Agent ${agent.agentId} changed from revision ${input.expectedRevision} to ${agent.currentRevision}. Refresh before queuing a test run.`,
      );
    }
    const revision = snapshot.revisions.find(
      (item) =>
        item.agentId === agent.agentId &&
        item.revision === agent.currentRevision,
    );
    if (!revision) {
      throw new Error(
        `Missing revision ${agent.currentRevision} for ${agent.agentId}.`,
      );
    }
    const [owner, repo] = revision.draft.targetScope.repository.split("/");
    if (!owner || !repo) {
      throw new Error("Agent repository scope is invalid.");
    }
    return this.#dispatcher.enqueue({
      agentId: agent.agentId,
      source: "test",
      idempotencyKey: `test:${agent.agentId}:${agent.currentRevision}:${this.#createId()}`,
      target: { ...input.target, owner, repo },
    });
  }

  listAgents(input: Partial<AgentListFilter> = {}): AgentListItem[] {
    const filter = agentListFilterSchema.parse(input);
    return buildAgentList(this.#store.load(), filter, this.#now());
  }

  getAgent(agentId: string): AgentDetailView | undefined {
    return buildAgentDetail(
      this.#store.load(),
      agentId,
      this.#now(),
      this.#operatorRuns(),
    );
  }

  /** Read-only snapshot for observability endpoints and tests. */
  getSnapshot(): AgentControlPlaneSnapshot {
    return this.#store.load();
  }

  /**
   * Build the U6 worker runtime over this service's shared store and
   * dispatcher. The plugin decides whether to start it; the stage decides
   * which sources the dispatcher may claim.
   */
  createRuntime(): ControlPlaneRuntime {
    const scheduler = new ScheduleScheduler(
      this.#store,
      this.#dispatcher,
      this.#createId,
      this.#now,
      { maxDueTriggers: 100 },
    );
    return new ControlPlaneRuntime(
      resolveRolloutStage(),
      this.#dispatcher,
      operatorPipelineQueueRunner,
      scheduler,
    );
  }

  private assertEnabledTrigger(agentId: string): void {
    const validTrigger = this.#store
      .load()
      .triggers.some(
        (trigger) =>
          trigger.agentId === agentId &&
          trigger.enabled &&
          agentTriggerSchema.safeParse(trigger).success,
      );
    if (!validTrigger) {
      throw new Error(
        "Create and validate at least one enabled trigger before enabling an agent.",
      );
    }
  }
}

function requireAgent(
  snapshot: AgentControlPlaneSnapshot,
  agentId: string,
): AgentDefinition {
  const agent = snapshot.agents.find((item) => item.agentId === agentId);
  if (!agent) throw new Error(`Unknown agent ${agentId}.`);
  return agent;
}

/**
 * Demo mode keeps the process-local store so isolated UI demos never write
 * host state; every other mode persists under the shipwright state directory
 * so the control plane survives service restarts.
 */
function createDefaultControlPlaneStore(): AgentControlPlaneStore {
  if (isOperatorDemoMode()) return new MemoryAgentControlPlaneStore();
  return new JsonFileAgentControlPlaneStore(
    join(resolveShipwrightStateDirectory(), "agent-control-plane.json"),
  );
}

let service: AgentManagementService | undefined;

export function getAgentManagementService(): AgentManagementService {
  service ??= new AgentManagementService();
  return service;
}
