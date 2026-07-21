import type { ExecutionRequest } from "../shared/agent-definition";
import type { QueueDispatcher, QueueRunner } from "./queue-dispatcher";
import type { ScheduleScheduler } from "./schedule-runner";

/**
 * U6 staged rollout. Stages are ordered and strictly additive:
 * disabled → operator test runs only → dry-run triggers →
 * approval-required publication → explicitly publish-allowed revisions.
 * The default is disabled: an untouched deployment never starts workers.
 */
export const ROLLOUT_STAGES = [
  "disabled",
  "test_only",
  "dry_run",
  "approval_required",
  "publish_allowed",
] as const;

export type RolloutStage = (typeof ROLLOUT_STAGES)[number];

export type RolloutEnvironment = {
  SHIPWRIGHT_ROLLOUT_STAGE?: string | undefined;
};

export function resolveRolloutStage(
  env: RolloutEnvironment = process.env as RolloutEnvironment,
): RolloutStage {
  const raw = env.SHIPWRIGHT_ROLLOUT_STAGE?.trim();
  if (!raw) return "disabled";
  if ((ROLLOUT_STAGES as readonly string[]).includes(raw)) {
    return raw as RolloutStage;
  }
  throw new Error(
    `SHIPWRIGHT_ROLLOUT_STAGE must be one of ${ROLLOUT_STAGES.join(", ")}; received ${JSON.stringify(raw)}.`,
  );
}

/** Execution sources the dispatcher may claim at this stage. */
export function sourcesDispatchableAtStage(
  stage: RolloutStage,
): ExecutionRequest["source"][] {
  if (stage === "disabled") return [];
  if (stage === "test_only") return ["test"];
  return ["test", "github", "schedule"];
}

/** Triggers may produce queue entries at any stage above test-only. */
export function schedulerActiveAtStage(stage: RolloutStage): boolean {
  return (
    stage !== "disabled" && stage !== "test_only"
  );
}

/**
 * Publication is a double opt-in: the deployment stage AND the pinned
 * revision's publication policy must both allow it. Every earlier stage
 * forces publish=false at the runner boundary.
 */
export function canPublishAtStage(
  stage: RolloutStage,
  publicationPolicy: "dry_run" | "approval_required" | "publish_allowed",
): boolean {
  return stage === "publish_allowed" && publicationPolicy === "publish_allowed";
}

export interface ControlPlaneRuntimeOptions {
  scheduleTickMs: number;
  queueTickMs: number;
  workerName: string;
}

const DEFAULT_OPTIONS: ControlPlaneRuntimeOptions = {
  scheduleTickMs: 30_000,
  queueTickMs: 2_000,
  workerName: "control-plane",
};

/**
 * Single-process ownership of the scheduler and queue dispatcher. One
 * systemd unit runs exactly one runtime; lease ownership in the store is the
 * cross-process claim boundary. Timers are unref'd so tests and shutdown are
 * not held open.
 */
export class ControlPlaneRuntime {
  #timers: NodeJS.Timeout[] = [];
  #dispatching = false;

  constructor(
    private readonly stage: RolloutStage,
    private readonly dispatcher: QueueDispatcher,
    private readonly runner: QueueRunner,
    private readonly scheduler?: ScheduleScheduler,
    private readonly options: ControlPlaneRuntimeOptions = DEFAULT_OPTIONS,
  ) {}

  start(): void {
    if (this.stage === "disabled" || this.#timers.length > 0) return;
    const sources = sourcesDispatchableAtStage(this.stage);
    const dispatchTick = () => {
      void this.dispatchAvailable(sources);
    };
    this.#timers.push(
      setInterval(dispatchTick, this.options.queueTickMs).unref(),
    );
    if (this.scheduler && schedulerActiveAtStage(this.stage)) {
      const scheduleTick = () => {
        try {
          this.scheduler?.runDue();
        } catch {
          // A failing tick must not kill the service; metrics expose the gap.
        }
      };
      this.#timers.push(
        setInterval(scheduleTick, this.options.scheduleTickMs).unref(),
      );
    }
    dispatchTick();
  }

  stop(): void {
    for (const timer of this.#timers.splice(0)) clearInterval(timer);
  }

  /** Drain every currently claimable entry; exported for tests and shutdown. */
  async dispatchAvailable(
    sources: ExecutionRequest["source"][],
  ): Promise<number> {
    if (this.#dispatching) return 0;
    this.#dispatching = true;
    try {
      let dispatched = 0;
      while (await this.dispatcher.dispatchNext(this.options.workerName, this.runner, sources)) {
        dispatched += 1;
      }
      return dispatched;
    } finally {
      this.#dispatching = false;
    }
  }
}
