import { createHmac, timingSafeEqual } from "node:crypto";

import { targetMatchesScope, type ExecutionRequest } from "../shared/agent-definition";
import type { AgentControlPlaneStore } from "./agent-control-plane";
import { QueueDispatcher } from "./queue-dispatcher";

const DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ACTION_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

type GitHubEvent = "issues" | "pull_request";

type WebhookTarget = {
  action: string;
  repository: string;
  target: ExecutionRequest["target"];
};

export type GitHubWebhookInput = {
  event: string;
  deliveryId: string;
  rawBody: string;
  signature: string;
};

export type GitHubWebhookResult =
  | { status: "accepted"; matched: number }
  | { status: "rejected"; reason: "invalid_signature" | "invalid_payload" };

export type GitHubWebhookIngressOptions = {
  webhookSecret: string;
  allowedRepositories: ReadonlySet<string>;
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
    const webhook = event ? this.parseTarget(event, input.rawBody) : undefined;
    if (!webhook) return { status: "rejected", reason: "invalid_payload" };
    if (!this.options.allowedRepositories.has(webhook.repository)) {
      return { status: "accepted", matched: 0 };
    }

    const snapshot = this.options.store.load();
    let matched = 0;
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
      const agent = snapshot.agents.find((item) => item.agentId === trigger.agentId);
      const revision = snapshot.revisions.find(
        (item) =>
          item.agentId === trigger.agentId && item.revision === trigger.agentRevision,
      );
      if (!agent?.enabled || !revision || !targetMatchesScope(webhook.target, revision.draft.targetScope)) {
        continue;
      }
      this.options.dispatcher.enqueue({
        agentId: trigger.agentId,
        triggerId: trigger.triggerId,
        source: "github",
        idempotencyKey: `github:${input.deliveryId}:${trigger.agentRevision}`,
        target: webhook.target,
      });
      matched += 1;
    }
    return { status: "accepted", matched };
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
    return value === "issues" || value === "pull_request" ? value : undefined;
  }

  private parseTarget(event: GitHubEvent, rawBody: string): WebhookTarget | undefined {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return undefined;
    }
    if (!isRecord(payload) || !ACTION_PATTERN.test(stringValue(payload.action))) {
      return undefined;
    }
    const repository = isRecord(payload.repository)
      ? stringValue(payload.repository.full_name).toLowerCase()
      : "";
    if (!REPOSITORY_PATTERN.test(repository)) return undefined;
    const [owner, repo] = repository.split("/");
    const number =
      event === "issues" && isRecord(payload.issue)
        ? payload.issue.number
        : event === "pull_request"
          ? payload.number
          : undefined;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
      return undefined;
    }
    return {
      action: stringValue(payload.action),
      repository,
      target: {
        kind: event === "issues" ? "issue" : "pull",
        owner,
        repo,
        number,
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
