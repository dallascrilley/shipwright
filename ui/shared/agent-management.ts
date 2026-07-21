import { z } from "zod";

import { redactSecrets } from "../../src/pipeline/secret-safety";
import type {
  AgentControlPlaneSnapshot,
  AgentDefinition,
  AgentDraft,
  AgentTrigger,
  ExecutionRequest,
  LifecycleEvent,
  QueueEntry,
} from "./agent-definition";
import type { OperatorRunRecord } from "./operator-run";

export const agentListFilterSchema = z
  .object({
    query: z.string().trim().max(120).optional().default(""),
    enabled: z.enum(["all", "enabled", "disabled"]).optional().default("all"),
    health: z
      .enum(["all", "idle", "queued", "running", "paused", "failed"])
      .optional()
      .default("all"),
  })
  .strict();

export type AgentListFilter = z.output<typeof agentListFilterSchema>;

export interface AgentActivityView {
  at: string;
  kind: "queue" | "schedule";
  label: string;
}

export interface AgentListItem {
  agentId: string;
  name: string;
  repository: string;
  branch?: string;
  skillId: string;
  publicationPolicy: AgentDraft["publicationPolicy"];
  currentRevision: number;
  enabled: boolean;
  health: AgentDefinition["health"];
  queuedRuns: number;
  activeRuns: number;
  runsLastSevenDays: number;
  successRate: number | undefined;
  lastOutcome: AgentDefinition["health"]["lastOutcome"];
  nextActivity?: AgentActivityView;
  lastAuditEvent?: LifecycleEvent;
}

export interface AgentQueueRunView {
  executionId: string;
  triggerId?: string;
  source: ExecutionRequest["source"];
  target: string;
  revision: number;
  state: QueueEntry["state"];
  scheduledAt: string;
  updatedAt: string;
  attempts: number;
  verificationPassed?: boolean;
  failureCode?: string;
}

export interface AgentEvidenceView {
  runId: string;
  status: OperatorRunRecord["status"];
  phase: OperatorRunRecord["phase"];
  updatedAt: string;
  summary?: string;
  verification?: {
    command: string;
    passed: boolean;
    exitCode: number | null;
  };
  changedFiles?: string[];
  pullRequestUrl?: string;
}

export interface AgentDetailView extends AgentListItem {
  config: AgentDraft;
  triggers: AgentTrigger[];
  runHistory: AgentQueueRunView[];
  evidence: AgentEvidenceView[];
  audit: LifecycleEvent[];
}

export function buildAgentList(
  snapshot: AgentControlPlaneSnapshot,
  filter: AgentListFilter,
  now: string,
): AgentListItem[] {
  const cutoff = Date.parse(now) - 7 * 24 * 60 * 60 * 1_000;
  return snapshot.agents
    .flatMap((agent) => {
      const revision = findCurrentRevision(snapshot, agent);
      if (!revision) return [];
      const item = buildListItem(snapshot, agent, revision.draft, cutoff);
      const query = filter.query.toLowerCase();
      const searchable = [
        item.agentId,
        item.name,
        item.repository,
        item.skillId,
      ]
        .join(" ")
        .toLowerCase();
      if (query && !searchable.includes(query)) return [];
      if (filter.enabled === "enabled" && !item.enabled) return [];
      if (filter.enabled === "disabled" && item.enabled) return [];
      if (filter.health !== "all" && item.health.state !== filter.health) {
        return [];
      }
      return [item];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function buildAgentDetail(
  snapshot: AgentControlPlaneSnapshot,
  agentId: string,
  now: string,
  operatorRuns: readonly OperatorRunRecord[] = [],
): AgentDetailView | undefined {
  const agent = snapshot.agents.find((item) => item.agentId === agentId);
  if (!agent) return undefined;
  const revision = findCurrentRevision(snapshot, agent);
  if (!revision) return undefined;
  const listItem = buildListItem(
    snapshot,
    agent,
    revision.draft,
    Date.parse(now) - 7 * 24 * 60 * 60 * 1_000,
  );
  const executions = new Map(
    snapshot.executions
      .filter((item) => item.agentId === agentId)
      .map((item) => [item.executionId, item]),
  );
  const runHistory = snapshot.queueEntries
    .filter((item) => item.agentId === agentId)
    .flatMap((entry) => {
      const execution = executions.get(entry.executionId);
      if (!execution) return [];
      return [toRunHistory(entry, execution)];
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    ...listItem,
    config: structuredClone(revision.draft),
    triggers: snapshot.triggers
      .filter((item) => item.agentId === agentId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((item) => structuredClone(item)),
    runHistory,
    evidence: operatorRuns
      .filter((record) => record.agentId === agentId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(toEvidence),
    audit: snapshot.lifecycleEvents
      .filter((item) => item.agentId === agentId)
      .sort((left, right) => right.sequence - left.sequence)
      .map((item) => structuredClone(item)),
  };
}

function buildListItem(
  snapshot: AgentControlPlaneSnapshot,
  agent: AgentDefinition,
  draft: AgentDraft,
  cutoff: number,
): AgentListItem {
  const entries = snapshot.queueEntries.filter(
    (item) => item.agentId === agent.agentId,
  );
  const terminalRecent = entries.filter(
    (entry) =>
      Date.parse(entry.updatedAt) >= cutoff &&
      [
        "succeeded",
        "failed",
        "cancelled",
        "interrupted",
        "dead_letter",
      ].includes(entry.state),
  );
  const successful = terminalRecent.filter(
    (item) => item.state === "succeeded",
  );
  const queueCandidates = entries
    .filter((item) => ["queued", "claimed", "running"].includes(item.state))
    .map<AgentActivityView>((item) => ({
      at: item.scheduledAt,
      kind: "queue",
      label: `Queued ${item.state} run`,
    }));
  const scheduleCandidates = snapshot.triggers
    .filter(
      (item) =>
        item.agentId === agent.agentId &&
        item.kind === "schedule" &&
        item.enabled &&
        !item.pausedAt &&
        item.nextFireAt,
    )
    .map<AgentActivityView>((item) => ({
      at: item.nextFireAt!,
      kind: "schedule",
      label: "Scheduled trigger",
    }));
  const nextActivity = [...queueCandidates, ...scheduleCandidates].sort(
    (left, right) => left.at.localeCompare(right.at),
  )[0];
  const latestAudit = snapshot.lifecycleEvents
    .filter((item) => item.agentId === agent.agentId)
    .sort((left, right) => right.sequence - left.sequence)[0];

  return {
    agentId: agent.agentId,
    name: draft.name,
    repository: draft.targetScope.repository,
    ...(draft.targetScope.branch ? { branch: draft.targetScope.branch } : {}),
    skillId: draft.skillId,
    publicationPolicy: draft.publicationPolicy,
    currentRevision: agent.currentRevision,
    enabled: agent.enabled,
    health: structuredClone(agent.health),
    queuedRuns: entries.filter((item) => item.state === "queued").length,
    activeRuns: entries.filter((item) =>
      ["claimed", "running"].includes(item.state),
    ).length,
    runsLastSevenDays:
      terminalRecent.length +
      entries.filter(
        (item) =>
          Date.parse(item.createdAt) >= cutoff &&
          ![
            "succeeded",
            "failed",
            "cancelled",
            "interrupted",
            "dead_letter",
          ].includes(item.state),
      ).length,
    successRate:
      terminalRecent.length > 0
        ? successful.length / terminalRecent.length
        : undefined,
    lastOutcome: agent.health.lastOutcome,
    ...(nextActivity ? { nextActivity } : {}),
    ...(latestAudit ? { lastAuditEvent: structuredClone(latestAudit) } : {}),
  };
}

function findCurrentRevision(
  snapshot: AgentControlPlaneSnapshot,
  agent: AgentDefinition,
) {
  return snapshot.revisions.find(
    (item) =>
      item.agentId === agent.agentId && item.revision === agent.currentRevision,
  );
}

function toRunHistory(
  entry: QueueEntry,
  execution: ExecutionRequest,
): AgentQueueRunView {
  return {
    executionId: execution.executionId,
    ...(execution.triggerId ? { triggerId: execution.triggerId } : {}),
    source: execution.source,
    target: `${execution.target.owner}/${execution.target.repo} #${execution.target.number}`,
    revision: execution.agentRevision,
    state: entry.state,
    scheduledAt: entry.scheduledAt,
    updatedAt: entry.updatedAt,
    attempts: entry.attempts,
    ...(entry.receipt
      ? { verificationPassed: entry.receipt.verificationPassed }
      : {}),
    ...(entry.failureCode ? { failureCode: entry.failureCode } : {}),
  };
}

function toEvidence(record: OperatorRunRecord): AgentEvidenceView {
  const receipt = record.receipt;
  return {
    runId: record.runId,
    status: record.status,
    phase: record.phase,
    updatedAt: record.updatedAt,
    ...(record.summary ? { summary: redactSecrets(record.summary) } : {}),
    ...(receipt
      ? {
          verification: {
            command: redactSecrets(receipt.verification.command),
            passed: receipt.verification.passed,
            exitCode: receipt.verification.exitCode,
          },
          changedFiles: receipt.changedFiles.map((item) => redactSecrets(item)),
          ...(receipt.pullRequestUrl
            ? { pullRequestUrl: redactSecrets(receipt.pullRequestUrl) }
            : {}),
        }
      : {}),
  };
}
