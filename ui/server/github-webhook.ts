import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { isRepositoryAllowed } from "../../src/config/github.js";
import {
  targetMatchesScope,
  type ExecutionRequest,
  type GithubTriggerCondition,
  type GithubTriggerEvent,
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

export type GitHubWebhookRelayDestination =
  | { kind: "disabled" }
  | { kind: "invalid" }
  | { kind: "private"; url: URL };

type GitHubEvent = GithubTriggerEvent;

type WebhookTarget = {
  action: string;
  repository: string;
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
} & ReviewAuthorization;

export function hasValidGitHubWebhookSignature(
  rawBody: string | Uint8Array,
  signature: string,
  webhookSecret: string,
): boolean {
  const expected = `sha256=${createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex")}`;
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function isValidGitHubDeliveryId(value: string): boolean {
  return DELIVERY_ID_PATTERN.test(value);
}

export function parseGitHubWebhookRelayDestination(
  value: unknown,
): GitHubWebhookRelayDestination {
  if (value === undefined || value === null || value === "") {
    return { kind: "disabled" };
  }
  if (typeof value !== "string") return { kind: "invalid" };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "invalid" };
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/webhooks/github" ||
    url.search !== "" ||
    url.hash !== "" ||
    !isPrivateHostname(url)
  ) {
    return { kind: "invalid" };
  }
  return { kind: "private", url };
}

/**
 * Identity a submitted review must prove before it may enqueue repair. The
 * reviewer is pinned on its bot *user* identity because that is what the
 * `pull_request_review` payload carries; `installationId` narrows the delivery
 * to the installation Shipwright itself runs as.
 */
type ReviewAuthorization = {
  expectedReviewerLogin?: string;
  expectedReviewerUserId?: number;
  installationId?: number;
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
    if (
      !hasValidGitHubWebhookSignature(
        input.rawBody,
        input.signature,
        this.options.webhookSecret,
      )
    ) {
      return { status: "rejected", reason: "invalid_signature" };
    }
    if (!isValidGitHubDeliveryId(input.deliveryId)) {
      return { status: "rejected", reason: "invalid_payload" };
    }
    const event = this.parseEvent(input.event);
    const webhook = event ? this.parseTarget(event, input.rawBody) : undefined;
    if (!webhook) return { status: "rejected", reason: "invalid_payload" };
    if (!isRepositoryAllowed(this.options, webhook.repository)) {
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
      // The queue entry deliberately carries only the target, not the review id
      // or the head SHA validated above. Execution re-authorizes the pull
      // request and re-derives its head from GitHub at run time: see
      // `runReviewAgent` in src/pipeline/review-run.ts, which compares the freshly
      // fetched `currentPullRequest.headSha` and `getBranchSha` result against
      // the authorized head and aborts with "pull request head moved after
      // authorization", then pins the workspace via `assertRunIdentity`.
      // Persisting the intake head would add a second, staler trust anchor for
      // a value the pipeline must re-verify anyway.
      this.options.dispatcher.enqueue({
        agentId: selected.agentId,
        triggerId: selected.triggerId,
        source: "github",
        idempotencyKey: `github:${input.deliveryId}:${selected.agentRevision}`,
        target: webhook.target,
      });
      matched += 1;
    }
    return acceptedResult(matched, decisions);
  }

  private parseEvent(value: string): GitHubEvent | undefined {
    return value === "issues" ||
      value === "pull_request" ||
      value === "pull_request_review"
      ? value
      : undefined;
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
    const subject = event === "issues" ? payload.issue : payload.pull_request;
    const number =
      event === "issues" && isRecord(subject)
        ? subject.number
        : event === "pull_request"
          ? payload.number
          : event === "pull_request_review" && isRecord(subject)
            ? subject.number
            : undefined;
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number <= 0
    ) {
      return undefined;
    }
    if (
      event === "pull_request_review" &&
      !isAuthorizedSubmittedReview(
        payload,
        subject,
        stringValue(payload.action),
        this.options,
      )
    ) {
      return undefined;
    }
    return {
      action: stringValue(payload.action),
      repository,
      conditionContext: {
        actor:
          event === "pull_request_review"
            ? readNestedStringField(payload.review, "user", "login")
            : readStringField(payload.sender, "login"),
        labels: readLabels(subject),
        baseBranch:
          event === "pull_request" || event === "pull_request_review"
            ? readNestedStringField(subject, "base", "ref")
            : { state: "missing" },
        draftState:
          event === "pull_request" || event === "pull_request_review"
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

function isPrivateHostname(url: URL): boolean {
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
  if (hostname === "localhost") return true;

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) return isPrivateIpv4(hostname);
  if (ipVersion === 6) return isPrivateIpv6(hostname);
  return url.protocol === "https:" && hostname.endsWith(".ts.net");
}

function isPrivateIpv4(hostname: string): boolean {
  const [first = -1, second = -1] = hostname
    .split(".")
    .map((part) => Number(part));
  return (
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  if (hostname === "::1") return true;
  const firstGroup = hostname.split(":", 1)[0] ?? "";
  const prefix = Number.parseInt(firstGroup, 16);
  return (
    Number.isFinite(prefix) &&
    ((prefix & 0xfe00) === 0xfc00 || (prefix & 0xffc0) === 0xfe80)
  );
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
 * A review delivery is actionable only when it is a *submitted* review from the
 * one configured reviewer identity, arriving on the configured installation, and
 * created against the pull request's current head. These values are
 * authenticated by the webhook signature but remain untrusted until every
 * cross-field check passes, so this never widens to "any bot".
 *
 * `review.state` is deliberately not filtered: approved and commented reviews
 * are accepted alongside changes_requested, because the repair stage no-ops when
 * a review carries zero actionable findings.
 */
function isAuthorizedSubmittedReview(
  payload: Record<string, unknown>,
  pullRequest: unknown,
  action: string,
  authorization: ReviewAuthorization,
): boolean {
  // Enforced here rather than resting on trigger-config curation alone.
  if (action !== "submitted") return false;

  // Fail closed: with no pinned reviewer identity, no reviewer is authorized.
  const expectedLogin = authorization.expectedReviewerLogin;
  if (!expectedLogin) return false;

  const installation = payload.installation;
  if (!isRecord(installation) || !isPositiveSafeInteger(installation.id)) {
    return false;
  }
  if (
    authorization.installationId !== undefined &&
    installation.id !== authorization.installationId
  ) {
    return false;
  }

  const review = payload.review;
  if (!isRecord(review) || !isPositiveSafeInteger(review.id)) return false;

  const reviewer = review.user;
  if (!isRecord(reviewer) || reviewer.type !== "Bot") return false;
  if (
    typeof reviewer.login !== "string" ||
    reviewer.login.toLowerCase() !== expectedLogin
  ) {
    return false;
  }
  if (
    authorization.expectedReviewerUserId !== undefined &&
    reviewer.id !== authorization.expectedReviewerUserId
  ) {
    return false;
  }

  const sender = payload.sender;
  if (
    !isRecord(sender) ||
    typeof sender.login !== "string" ||
    sender.login !== reviewer.login
  ) {
    return false;
  }

  const reviewCommit = readStringField(review, "commit_id");
  const headSha = readNestedStringField(pullRequest, "head", "sha");
  return (
    reviewCommit.state === "available" &&
    headSha.state === "available" &&
    reviewCommit.value === headSha.value
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
