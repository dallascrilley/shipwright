import { createHmac, timingSafeEqual } from "node:crypto";

import { isRepositoryAllowed } from "../../src/config/github.js";
import {
  targetMatchesScope,
  type ExecutionRequest,
  type GithubTriggerCondition,
} from "../shared/agent-definition";
import type { AgentControlPlaneStore } from "./agent-control-plane";
import {
  evaluateGithubTriggerConditions,
  type GitHubTriggerConditionContext,
  type GitHubTriggerConditionFieldState,
  type GitHubTriggerConditionReasonCode,
} from "./github-trigger-conditions";
import { QueueDispatcher } from "./queue-dispatcher";

const DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ACTION_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
export const MAX_WEBHOOK_DECISIONS = 20;

type GitHubEvent =
  | "issues"
  | "pull_request"
  | "pull_request_review_comment"
  | "pull_request_review";

const REVIEW_WAKE_EVENTS: ReadonlySet<GitHubEvent> = new Set([
  "pull_request_review_comment",
  "pull_request_review",
]);

type WebhookTarget = {
  action: string;
  repository: string;
  senderIsHuman: boolean;
  target: ExecutionRequest["target"];
  conditionContext: GitHubTriggerConditionContext;
};

type TriggerCandidate = {
  triggerId: string;
  agentId: string;
  agentRevision: number;
  conditions: GithubTriggerCondition[];
};

export type GitHubWebhookDecision = {
  triggerId: string;
  decision: "matched" | "filtered";
  reasonCodes: GitHubTriggerConditionReasonCode[];
};

export type GitHubWebhookInput = {
  event: string;
  deliveryId: string;
  rawBody: string;
  signature: string;
};

export type GitHubWebhookResult =
  | {
      status: "accepted";
      matched: number;
      conditionFiltered: number;
      decisions: GitHubWebhookDecision[];
      decisionsTruncated: number;
    }
  | { status: "rejected"; reason: "invalid_signature" | "invalid_payload" };

export type GitHubWebhookIngressOptions = {
  webhookSecret: string;
  allowedRepositories: ReadonlySet<string>;
  allowedOwners: ReadonlySet<string>;
  store: AgentControlPlaneStore;
  dispatcher: QueueDispatcher;
};

/**
 * Verifies an authenticated GitHub body before selecting only the delivery metadata
 * needed for trigger matching. The raw body never enters control-plane storage.
 */
export class GitHubWebhookIngress {
  constructor(private readonly options: GitHubWebhookIngressOptions) {}

  async receive(input: GitHubWebhookInput): Promise<GitHubWebhookResult> {
    if (Buffer.byteLength(input.rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
      return { status: "rejected", reason: "invalid_payload" };
    }
    if (!this.hasValidSignature(input.rawBody, input.signature)) {
      return { status: "rejected", reason: "invalid_signature" };
    }
    if (!DELIVERY_ID_PATTERN.test(input.deliveryId)) {
      return { status: "rejected", reason: "invalid_payload" };
    }
    const event = this.parseEvent(input.event);
    if (!event) return { status: "rejected", reason: "invalid_payload" };
    const webhook = this.parseTarget(event, input.rawBody);
    if (!webhook) return { status: "rejected", reason: "invalid_payload" };
    if (!isRepositoryAllowed(this.options, webhook.repository)) {
      return acceptedResult(0, []);
    }
    // The review pipeline replies to threads as this App, and its own reply is
    // itself a review-comment delivery. Waking on it would re-run the agent,
    // which replies again -- unbounded on any thread the pipeline leaves
    // unresolved (`needs-human`). Only a sender readable as human wakes the
    // review events; a bot or an unnameable sender does not. Issue and
    // pull_request events keep their existing behavior.
    if (REVIEW_WAKE_EVENTS.has(event) && !webhook.senderIsHuman) {
      return acceptedResult(0, []);
    }

    const snapshot = this.options.store.load();
    const candidatesByRevision = new Map<string, TriggerCandidate[]>();
    for (const trigger of snapshot.triggers) {
      if (
        trigger.kind !== "github" ||
        !trigger.enabled ||
        !("event" in trigger.config) ||
        trigger.config.event !== event ||
        !trigger.config.actions.includes(webhook.action)
      ) {
        continue;
      }
      const agent = snapshot.agents.find(
        (item) => item.agentId === trigger.agentId,
      );
      const revision = snapshot.revisions.find(
        (item) =>
          item.agentId === trigger.agentId &&
          item.revision === trigger.agentRevision,
      );
      if (
        !agent?.enabled ||
        !revision ||
        !targetMatchesScope(webhook.target, revision.draft.targetScope)
      ) {
        continue;
      }
      const key = `${trigger.agentId}:${trigger.agentRevision}`;
      const candidates = candidatesByRevision.get(key) ?? [];
      candidates.push({
        triggerId: trigger.triggerId,
        agentId: trigger.agentId,
        agentRevision: trigger.agentRevision,
        conditions: structuredClone(trigger.config.conditions ?? []),
      });
      candidatesByRevision.set(key, candidates);
    }

    let matched = 0;
    const decisions: GitHubWebhookDecision[] = [];
    const candidateGroups = [...candidatesByRevision.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    );
    for (const [, candidates] of candidateGroups) {
      candidates.sort((left, right) =>
        left.triggerId.localeCompare(right.triggerId),
      );
      const evaluated = candidates.map((candidate) => ({
        candidate,
        evaluation: evaluateGithubTriggerConditions(
          candidate.conditions,
          webhook.conditionContext,
        ),
      }));
      for (const { candidate, evaluation } of evaluated) {
        decisions.push({
          triggerId: candidate.triggerId,
          decision: evaluation.matched ? "matched" : "filtered",
          reasonCodes: evaluation.reasonCodes,
        });
      }
      const selected = evaluated.find(
        (item) => item.evaluation.matched,
      )?.candidate;
      if (!selected) continue;
      this.options.dispatcher.enqueue({
        agentId: selected.agentId,
        triggerId: selected.triggerId,
        source: "github",
        idempotencyKey: `github:${input.deliveryId}:${selected.agentRevision}`,
        target: webhook.target,
        coalesceInFlight: REVIEW_WAKE_EVENTS.has(event),
      });
      matched += 1;
    }
    return acceptedResult(matched, decisions);
  }

  private hasValidSignature(rawBody: string, signature: string): boolean {
    const expected = `sha256=${createHmac("sha256", this.options.webhookSecret)
      .update(rawBody)
      .digest("hex")}`;
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    return (
      actualBytes.byteLength === expectedBytes.byteLength &&
      timingSafeEqual(actualBytes, expectedBytes)
    );
  }

  private parseEvent(value: string): GitHubEvent | undefined {
    if (
      value === "issues" ||
      value === "pull_request" ||
      value === "pull_request_review_comment" ||
      value === "pull_request_review"
    ) {
      return value;
    }
    return undefined;
  }

  private parseTarget(
    event: GitHubEvent,
    rawBody: string,
  ): WebhookTarget | undefined {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return undefined;
    }
    if (
      !isRecord(payload) ||
      !ACTION_PATTERN.test(stringValue(payload.action))
    ) {
      return undefined;
    }
    const repository = isRecord(payload.repository)
      ? stringValue(payload.repository.full_name).toLowerCase()
      : "";
    if (!REPOSITORY_PATTERN.test(repository)) return undefined;
    const [owner, repo] = repository.split("/");
    const subject = subjectForEvent(event, payload);
    const number = numberForEvent(event, payload, subject);
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number <= 0
    ) {
      return undefined;
    }
    const isPullTarget = event !== "issues";
    return {
      action: stringValue(payload.action),
      repository,
      senderIsHuman: isHumanSender(payload.sender),
      conditionContext: {
        actor: readStringField(payload.sender, "login"),
        labels: readLabels(subject),
        baseBranch: isPullTarget
          ? readNestedStringField(subject, "base", "ref")
          : { state: "missing" },
        draftState: isPullTarget
          ? readBooleanField(subject, "draft")
          : { state: "missing" },
      },
      target: {
        kind: event === "issues" ? "issue" : "pull",
        owner,
        repo,
        number,
      },
    };
  }
}

function subjectForEvent(
  event: GitHubEvent,
  payload: Record<string, unknown>,
): unknown {
  switch (event) {
    case "issues":
      return payload.issue;
    case "pull_request":
    case "pull_request_review_comment":
    case "pull_request_review":
      return payload.pull_request;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function numberForEvent(
  event: GitHubEvent,
  payload: Record<string, unknown>,
  subject: unknown,
): unknown {
  switch (event) {
    case "issues":
      return isRecord(subject) ? subject.number : undefined;
    case "pull_request":
      return payload.number;
    case "pull_request_review_comment":
    case "pull_request_review":
      return isRecord(subject) ? subject.number : undefined;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function acceptedResult(
  matched: number,
  decisions: GitHubWebhookDecision[],
): Extract<GitHubWebhookResult, { status: "accepted" }> {
  const conditionFiltered = decisions.filter(
    (decision) => decision.decision === "filtered",
  ).length;
  return {
    status: "accepted",
    matched,
    conditionFiltered,
    decisions: decisions.slice(0, MAX_WEBHOOK_DECISIONS),
    decisionsTruncated: Math.max(0, decisions.length - MAX_WEBHOOK_DECISIONS),
  };
}

function readStringField(
  container: unknown,
  key: string,
): GitHubTriggerConditionFieldState<string> {
  if (container === undefined || container === null)
    return { state: "missing" };
  if (!isRecord(container)) return { state: "malformed" };
  if (!(key in container)) return { state: "missing" };
  const value = container[key];
  return typeof value === "string" && value.length > 0
    ? { state: "available", value }
    : { state: "malformed" };
}

function readNestedStringField(
  container: unknown,
  parentKey: string,
  key: string,
): GitHubTriggerConditionFieldState<string> {
  if (container === undefined || container === null)
    return { state: "missing" };
  if (!isRecord(container)) return { state: "malformed" };
  if (!(parentKey in container)) return { state: "missing" };
  return readStringField(container[parentKey], key);
}

function readBooleanField(
  container: unknown,
  key: string,
): GitHubTriggerConditionFieldState<boolean> {
  if (container === undefined || container === null)
    return { state: "missing" };
  if (!isRecord(container)) return { state: "malformed" };
  if (!(key in container)) return { state: "missing" };
  return typeof container[key] === "boolean"
    ? { state: "available", value: container[key] }
    : { state: "malformed" };
}

function readLabels(
  container: unknown,
): GitHubTriggerConditionFieldState<string[]> {
  if (container === undefined || container === null)
    return { state: "missing" };
  if (!isRecord(container)) return { state: "malformed" };
  if (!("labels" in container)) return { state: "missing" };
  if (!Array.isArray(container.labels)) return { state: "malformed" };
  const labels: string[] = [];
  for (const label of container.labels) {
    if (!isRecord(label) || typeof label.name !== "string" || !label.name) {
      return { state: "malformed" };
    }
    labels.push(label.name);
  }
  return { state: "available", value: labels };
}

/**
 * Only a readable, non-bot sender counts as human. GitHub sets `sender.type`
 * to "Bot" for App activity and suffixes App logins "[bot]"; either signal
 * alone is enough, since a payload may carry only one. An absent or unreadable
 * sender is not human either: this gates a runaway-cost guard, so ambiguity
 * must not wake an agent, and a real review delivery always names its sender.
 */
function isHumanSender(sender: unknown): boolean {
  if (!isRecord(sender)) return false;
  return (
    stringValue(sender.type).toLowerCase() !== "bot" &&
    !stringValue(sender.login).toLowerCase().endsWith("[bot]")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
