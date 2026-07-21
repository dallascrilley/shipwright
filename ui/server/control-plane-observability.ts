import { containsSecretLikeContent } from "../../src/pipeline/secret-safety.js";
import type { AgentControlPlaneSnapshot } from "../shared/agent-definition";
import {
  schedulerActiveAtStage,
  type RolloutStage,
} from "./control-plane-runtime";

export interface ControlPlaneStatusInput {
  snapshot: AgentControlPlaneSnapshot;
  stage: RolloutStage;
  storePath: string;
  now: string;
}

export interface ControlPlaneReadiness {
  ok: boolean;
  stage: RolloutStage;
  snapshotVersion: number;
  reasons: string[];
}

const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "dead_letter",
]);

/** Allow one full scheduler tick of grace before a due trigger trips readiness. */
const SCHEDULE_GRACE_MS = 5 * 60_000;

export function buildControlPlaneReadiness(
  input: ControlPlaneStatusInput,
): ControlPlaneReadiness {
  const reasons: string[] = [];
  const { snapshot, stage, now } = input;
  if (snapshot.version !== 1) {
    reasons.push(`unsupported snapshot version ${snapshot.version}`);
  }

  if (schedulerActiveAtStage(stage)) {
    const overdue = snapshot.triggers.filter((trigger) => {
      if (trigger.kind !== "schedule" || !trigger.enabled || trigger.pausedAt) {
        return false;
      }
      const agent = snapshot.agents.find(
        (candidate) => candidate.agentId === trigger.agentId,
      );
      if (!agent?.enabled || agent.health.state === "paused") return false;
      const nextFireAt = trigger.nextFireAt;
      if (typeof nextFireAt !== "string") return false;
      return Date.parse(nextFireAt) + SCHEDULE_GRACE_MS < Date.parse(now);
    });
    if (overdue.length > 0) {
      reasons.push(`schedule scanner overdue for ${overdue.length} trigger(s)`);
    }
  }

  return {
    ok: reasons.length === 0,
    stage,
    snapshotVersion: snapshot.version,
    reasons,
  };
}

export interface ControlPlaneMetricsInput {
  snapshot: AgentControlPlaneSnapshot;
  stage: RolloutStage;
  now: string;
}

/**
 * Prometheus text exposition over aggregate control-plane state only.
 * Deliberate omissions: agent ids, target URLs, repository names, run ids,
 * trigger ids, instructions, and any operator-supplied text. Every emitted
 * value is a number derived from counts, timestamps, or a fixed stage enum.
 */
export function buildMetricsText(input: ControlPlaneMetricsInput): string {
  const { snapshot, stage, now } = input;
  const nowTime = Date.parse(now);
  const lines: string[] = [];

  const queueByState = new Map<string, number>();
  let activeLeaseMaxAgeMs = 0;
  for (const entry of snapshot.queueEntries) {
    queueByState.set(entry.state, (queueByState.get(entry.state) ?? 0) + 1);
    if (
      (entry.state === "claimed" || entry.state === "running") &&
      entry.lease
    ) {
      const age = nowTime - (Date.parse(entry.lease.expiresAt) - 60_000);
      activeLeaseMaxAgeMs = Math.max(activeLeaseMaxAgeMs, age);
    }
  }
  lines.push(
    "# HELP shipwright_queue_entries Queue entries by state.",
    "# TYPE shipwright_queue_entries gauge",
  );
  for (const [state, count] of [...queueByState].sort()) {
    assertMetricFragmentSafe(state, "queue state");
    lines.push(`shipwright_queue_entries{state="${state}"} ${count}`);
  }

  const terminal = snapshot.queueEntries.filter((entry) =>
    TERMINAL_STATES.has(entry.state),
  ).length;
  lines.push(
    "# HELP shipwright_queue_terminal_entries Terminal queue entries retained in the snapshot.",
    "# TYPE shipwright_queue_terminal_entries gauge",
    `shipwright_queue_terminal_entries ${terminal}`,
    "# HELP shipwright_oldest_active_lease_age_seconds Oldest active lease age in seconds.",
    "# TYPE shipwright_oldest_active_lease_age_seconds gauge",
    `shipwright_oldest_active_lease_age_seconds ${Math.max(0, Math.round(activeLeaseMaxAgeMs / 1000))}`,
  );

  const lifecycleByAction = new Map<string, number>();
  for (const event of snapshot.lifecycleEvents) {
    lifecycleByAction.set(
      event.action,
      (lifecycleByAction.get(event.action) ?? 0) + 1,
    );
  }
  lines.push(
    "# HELP shipwright_lifecycle_events_total Lifecycle audit events by action.",
    "# TYPE shipwright_lifecycle_events_total counter",
  );
  for (const [action, count] of [...lifecycleByAction].sort()) {
    assertMetricFragmentSafe(action, "lifecycle action");
    lines.push(`shipwright_lifecycle_events_total{action="${action}"} ${count}`);
  }

  const pausedBreakers = snapshot.triggers.filter(
    (trigger) => trigger.pausedAt,
  ).length;
  lines.push(
    "# HELP shipwright_paused_circuit_breakers Paused schedule circuit breakers.",
    "# TYPE shipwright_paused_circuit_breakers gauge",
    `shipwright_paused_circuit_breakers ${pausedBreakers}`,
    "# HELP shipwright_rollout_stage Configured rollout stage (always 1).",
    "# TYPE shipwright_rollout_stage gauge",
    `shipwright_rollout_stage{stage="${stage}"} 1`,
  );

  return `${lines.join("\n")}\n`;
}

/** Metric fragments are schema-derived enums; defense in depth against drift. */
function assertMetricFragmentSafe(value: string, what: string): void {
  if (!/^[a-z_]+$/.test(value) || containsSecretLikeContent(value)) {
    throw new Error(`Refusing to export unsafe ${what} in metrics.`);
  }
}
