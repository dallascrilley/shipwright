import {
  assertBodySize,
  defineEventHandler,
  setResponseHeader,
  setResponseStatus,
  type H3Event,
} from "h3";

import {
  parseGitHubConfig,
  parseGitHubWebhookRelayDestination,
  parseGitHubWebhookConfig,
  selectGitHubWebhookEventFamily,
  selectGitHubWebhookIngressConfig,
  type GitHubWebhookConfig,
  type GitHubWebhookIngressConfig,
  type GitHubWebhookRelayDestination,
} from "../../../../../src/config/github.js";
import {
  authorizePullRequestMetadata,
  createOctokitTransport,
  PullRequestAuthorizationError,
} from "../../../../../src/github/app-client.js";
import { parsePullRequestUrl } from "../../../../../src/github/pull-request-ref.js";
import {
  buildReviewRequest,
  parseReviewCommand,
  ReviewRequestConflictError,
  signReviewRequest,
} from "../../../../../src/github/review-request.js";
import type { PullRequestContext } from "../../../../../src/github/types.js";
import { getAgentManagementService } from "../../../agent-management";
import {
  MAX_WEBHOOK_BODY_BYTES,
  hasValidGitHubWebhookSignature,
  isGitHubWebhookRepositoryAllowed,
  isValidGitHubDeliveryId,
  validateGitHubCheckSuiteRelayPayload,
  validateGitHubWebhookTrustPayload,
  type GitHubWebhookInput,
  type GitHubWebhookResult,
} from "../../../github-webhook";

const DEFAULT_RELAY_TIMEOUT_MS = 5_000;
const MAX_COMPLETED_RELAY_DELIVERIES = 10_000;
const RETRY_AFTER_SECONDS = "10";

type RelayFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GitHubWebhookRouteDependencies {
  loadConfig?: () => GitHubWebhookConfig;
  receive?: (
    input: GitHubWebhookInput,
    config: GitHubWebhookIngressConfig,
  ) => Promise<GitHubWebhookResult>;
  loadRelayDestination?: (event: H3Event) => unknown;
  relayFetch?: RelayFetch;
  reviewRequestFetch?: RelayFetch;
  authorizeReviewCommand?: (
    repository: string,
    pullNumber: number,
  ) => Promise<PullRequestContext>;
  now?: () => number;
  relayTimeoutMs?: number;
}

/** Public GitHub boundary. It authenticates exact bytes before any local or relay effect. */
export function createGitHubWebhookRoute(
  dependencies: GitHubWebhookRouteDependencies = {},
) {
  const loadConfig =
    dependencies.loadConfig ?? (() => parseGitHubWebhookConfig());
  const receive =
    dependencies.receive ??
    ((input, config) =>
      getAgentManagementService().receiveGitHubWebhook(input, config));
  const relayFetch = dependencies.relayFetch ?? fetch;
  const reviewRequestFetch = dependencies.reviewRequestFetch ?? fetch;
  const authorizeReviewCommand =
    dependencies.authorizeReviewCommand ?? defaultAuthorizeReviewCommand;
  const now = dependencies.now ?? Date.now;
  const relayTimeoutMs =
    dependencies.relayTimeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(relayTimeoutMs) ||
    relayTimeoutMs <= 0 ||
    relayTimeoutMs > DEFAULT_RELAY_TIMEOUT_MS
  ) {
    throw new Error(
      `GitHub webhook relay timeout must be between 1 and ${DEFAULT_RELAY_TIMEOUT_MS} milliseconds`,
    );
  }
  const completedRelays = new Set<string>();
  const activeRelays = new Map<string, Promise<boolean>>();

  return defineEventHandler(async (event) => {
    await assertBodySize(event, MAX_WEBHOOK_BODY_BYTES);
    const rawBody = await event.req.arrayBuffer();
    const rawBytes = new Uint8Array(rawBody);
    const githubEvent = event.req.headers.get("x-github-event") ?? "";
    const deliveryId = event.req.headers.get("x-github-delivery") ?? "";
    const signature = event.req.headers.get("x-hub-signature-256") ?? "";
    const contentType = event.req.headers.get("content-type");
    const rawText = Buffer.from(rawBody).toString("utf8");

    try {
      const config = loadConfig();
      const family = selectGitHubWebhookEventFamily(githubEvent, config);
      if (family === undefined) {
        setResponseStatus(event, 400);
        return { status: "rejected", reason: "invalid_payload" };
      }
      const ingressConfig = selectGitHubWebhookIngressConfig(config, family);
      if (
        !hasValidGitHubWebhookSignature(
          rawBytes,
          signature,
          ingressConfig.webhookSecret,
        )
      ) {
        setResponseStatus(event, 401);
        return { status: "rejected", reason: "invalid_signature" };
      }
      if (!isValidGitHubDeliveryId(deliveryId)) {
        setResponseStatus(event, 400);
        return { status: "rejected", reason: "invalid_payload" };
      }

      const trustValidation = validateGitHubWebhookTrustPayload(
        rawText,
        ingressConfig,
        ingressConfig.installationId,
      );
      if (trustValidation.kind === "invalid") {
        setResponseStatus(event, 400);
        return { status: "rejected", reason: "invalid_payload" };
      }
      if (trustValidation.kind === "wrong_installation") {
        if (githubEvent === "issue_comment") {
          setResponseStatus(event, 202);
          return acceptedWithoutLocalIntake();
        }
        setResponseStatus(event, 400);
        return { status: "rejected", reason: "invalid_payload" };
      }
      if (trustValidation.kind === "disallowed") {
        setResponseStatus(event, 202);
        return acceptedWithoutLocalIntake();
      }

      if (githubEvent === "issue_comment") {
        const commandConfig = config.reviewCommand;
        if (commandConfig === undefined) {
          setResponseStatus(event, 202);
          return acceptedWithoutLocalIntake();
        }
        const parsed = parseReviewCommand(rawText, deliveryId, commandConfig);
        if (parsed.kind === "ignored") {
          setResponseStatus(event, 202);
          return acceptedWithoutLocalIntake();
        }
        try {
          const authorized = await authorizeReviewCommand(
            parsed.candidate.repository,
            parsed.candidate.pullNumber,
          );
          if (authorized.draft) {
            setResponseStatus(event, 202);
            return acceptedWithoutLocalIntake();
          }
          const request = buildReviewRequest(
            parsed.candidate,
            authorized,
            ingressConfig.installationId,
          );
          const signed = signReviewRequest(
            request,
            commandConfig.protocolSecret,
            Math.floor(now() / 1000).toString(),
          );
          const response = await reviewRequestFetch(commandConfig.requestUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-shipwright-request-id": signed.requestId,
              "x-shipwright-timestamp": signed.timestamp,
              "x-shipwright-signature-256": signed.signature,
            },
            body: signed.rawBody,
            redirect: "error",
            signal: AbortSignal.timeout(relayTimeoutMs),
          });
          await response.body?.cancel();
          if (response.status === 202) {
            setResponseStatus(event, 202);
            return acceptedWithoutLocalIntake();
          }
          if (response.status === 409) {
            setResponseStatus(event, 409);
            return { status: "rejected", reason: "review_request_conflict" };
          }
          console.error("Symphony review request unavailable");
          return unavailable(event, true);
        } catch (error) {
          if (error instanceof PullRequestAuthorizationError) {
            setResponseStatus(event, 202);
            return acceptedWithoutLocalIntake();
          }
          if (error instanceof ReviewRequestConflictError) {
            setResponseStatus(event, 409);
            return { status: "rejected", reason: "review_request_conflict" };
          }
          console.error("Shipwright review command unavailable");
          return unavailable(event, true);
        }
      }

      const relayDestination = parseGitHubWebhookRelayDestination(
        dependencies.loadRelayDestination?.(event) ??
          ingressConfig.symphonyWebhookUrl,
      );
      if (relayDestination.kind === "invalid") {
        console.error("GitHub webhook relay destination rejected");
        return unavailable(event);
      }

      if (
        githubEvent === "check_suite" &&
        relayDestination.kind === "private"
      ) {
        const validation = validateGitHubCheckSuiteRelayPayload(
          rawText,
          ingressConfig,
        );
        if (validation.kind === "invalid") {
          setResponseStatus(event, 400);
          return { status: "rejected", reason: "invalid_payload" };
        }
        if (validation.kind === "disallowed") {
          setResponseStatus(event, 202);
          return acceptedWithoutLocalIntake();
        }
        if (
          !(await relayOnce({
            destination: relayDestination,
            deliveryId,
            githubEvent,
            signature,
            contentType,
            rawBody,
          }))
        ) {
          console.error("GitHub webhook relay unavailable");
          return unavailable(event, true);
        }
        setResponseStatus(event, 202);
        return acceptedWithoutLocalIntake();
      }

      const input: GitHubWebhookInput = {
        event: githubEvent,
        deliveryId,
        signature,
        rawBody: rawText,
      };
      const result = await receive(input, ingressConfig);
      if (result.status === "accepted") {
        if (
          githubEvent === "pull_request" &&
          relayDestination.kind === "private" &&
          isGitHubWebhookRepositoryAllowed(input.rawBody, ingressConfig) &&
          !(await relayOnce({
            destination: relayDestination,
            deliveryId,
            githubEvent,
            signature,
            contentType,
            rawBody,
          }))
        ) {
          console.error("GitHub webhook relay unavailable");
          return unavailable(event, true);
        }
        setResponseStatus(event, 202);
        return result;
      }
      setResponseStatus(
        event,
        result.reason === "invalid_signature" ? 401 : 400,
      );
      return result;
    } catch {
      console.error("GitHub webhook ingress unavailable");
      return unavailable(event);
    }
  });

  async function relayOnce(input: {
    destination: Extract<
      GitHubWebhookRelayDestination,
      { kind: "private" }
    >;
    deliveryId: string;
    githubEvent: string;
    signature: string;
    contentType: string | null;
    rawBody: ArrayBuffer;
  }): Promise<boolean> {
    const relayKey = `${input.destination.url.href}\n${input.deliveryId}`;
    if (completedRelays.has(relayKey)) return true;
    const activeRelay = activeRelays.get(relayKey);
    if (activeRelay) return activeRelay;

    const attempt = sendRelay(input);
    activeRelays.set(relayKey, attempt);
    try {
      const succeeded = await attempt;
      if (succeeded) rememberCompletedRelay(relayKey);
      return succeeded;
    } finally {
      activeRelays.delete(relayKey);
    }
  }

  async function sendRelay(input: {
    destination: Extract<
      GitHubWebhookRelayDestination,
      { kind: "private" }
    >;
    deliveryId: string;
    githubEvent: string;
    signature: string;
    contentType: string | null;
    rawBody: ArrayBuffer;
  }): Promise<boolean> {
    try {
      const response = await relayFetch(input.destination.url, {
        method: "POST",
        headers: {
          "X-GitHub-Delivery": input.deliveryId,
          "X-GitHub-Event": input.githubEvent,
          "X-Hub-Signature-256": input.signature,
          ...(input.contentType === null
            ? {}
            : { "Content-Type": input.contentType }),
        },
        body: input.rawBody,
        redirect: "error",
        signal: AbortSignal.timeout(relayTimeoutMs),
      });
      await response.body?.cancel();
      return response.status === 202;
    } catch {
      return false;
    }
  }

  function rememberCompletedRelay(relayKey: string): void {
    completedRelays.add(relayKey);
    if (completedRelays.size <= MAX_COMPLETED_RELAY_DELIVERIES) return;
    const oldestRelayKey = completedRelays.values().next().value;
    if (oldestRelayKey !== undefined) completedRelays.delete(oldestRelayKey);
  }
}

async function defaultAuthorizeReviewCommand(
  repository: string,
  pullNumber: number,
): Promise<PullRequestContext> {
  const config = parseGitHubConfig();
  const pullRequest = parsePullRequestUrl(
    `https://github.com/${repository}/pull/${pullNumber}`,
  );
  const authorized = await authorizePullRequestMetadata(
    pullRequest,
    config,
    createOctokitTransport(config),
  );
  return authorized.pullRequest;
}

function acceptedWithoutLocalIntake(): GitHubWebhookResult {
  return {
    status: "accepted",
    matched: 0,
    conditionFiltered: 0,
    decisions: [],
    decisionsTruncated: 0,
  };
}

function unavailable(event: H3Event, retryable = false) {
  setResponseStatus(event, 503);
  if (retryable) setResponseHeader(event, "Retry-After", RETRY_AFTER_SECONDS);
  return { status: "unavailable" as const };
}

export default createGitHubWebhookRoute();
