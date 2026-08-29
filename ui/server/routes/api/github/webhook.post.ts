import { createHash } from "node:crypto";

import {
  assertBodySize,
  defineEventHandler,
  setResponseHeader,
  setResponseStatus,
  type H3Event,
} from "h3";

import {
  parseGitHubWebhookConfig,
  type GitHubWebhookConfig,
} from "../../../../../src/config/github.js";
import { getAgentManagementService } from "../../../agent-management";
import {
  MAX_WEBHOOK_BODY_BYTES,
  hasValidGitHubWebhookSignature,
  isValidGitHubDeliveryId,
  parseGitHubWebhookRelayDestination,
  type GitHubWebhookInput,
  type GitHubWebhookResult,
  type GitHubWebhookRelayDestination,
} from "../../../github-webhook";

const DEFAULT_RELAY_TIMEOUT_MS = 5_000;
const MAX_COMPLETED_RELAY_DELIVERIES = 10_000;
const RETRY_AFTER_SECONDS = "10";

type RelayResult = "accepted" | "conflict" | "unavailable";

type ActiveRelay = {
  payloadSha256: string;
  result: Promise<RelayResult>;
};

type RelayFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GitHubWebhookRouteDependencies {
  loadConfig?: () => GitHubWebhookConfig;
  receive?: (
    input: GitHubWebhookInput,
    config: GitHubWebhookConfig,
  ) => Promise<GitHubWebhookResult>;
  loadRelayDestination?: (event: H3Event) => unknown;
  relayFetch?: RelayFetch;
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
  const completedRelays = new Map<string, string>();
  const activeRelays = new Map<string, ActiveRelay>();

  return defineEventHandler(async (event) => {
    await assertBodySize(event, MAX_WEBHOOK_BODY_BYTES);
    const rawBody = await event.req.arrayBuffer();
    const rawBytes = new Uint8Array(rawBody);
    const githubEvent = event.req.headers.get("x-github-event") ?? "";
    const deliveryId = event.req.headers.get("x-github-delivery") ?? "";
    const signature = event.req.headers.get("x-hub-signature-256") ?? "";

    try {
      const config = loadConfig();
      if (
        !hasValidGitHubWebhookSignature(
          rawBytes,
          signature,
          config.webhookSecret,
        )
      ) {
        setResponseStatus(event, 401);
        return { status: "rejected", reason: "invalid_signature" };
      }
      if (!isValidGitHubDeliveryId(deliveryId)) {
        setResponseStatus(event, 400);
        return { status: "rejected", reason: "invalid_payload" };
      }

      const relayDestination = parseGitHubWebhookRelayDestination(
        dependencies.loadRelayDestination?.(event) ?? config.symphonyWebhookUrl,
      );
      if (relayDestination.kind === "invalid") {
        console.error("GitHub webhook relay destination rejected");
        return unavailable(event);
      }

      if (
        githubEvent === "check_suite" &&
        relayDestination.kind === "private"
      ) {
        const relayResult = await relayOnce({
          destination: relayDestination,
          deliveryId,
          githubEvent,
          signature,
          rawBody,
        });
        if (relayResult === "conflict") return conflict(event);
        if (relayResult === "unavailable") {
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
        rawBody: Buffer.from(rawBody).toString("utf8"),
      };
      const result = await receive(input, config);
      if (result.status === "accepted") {
        if (
          githubEvent === "pull_request" &&
          relayDestination.kind === "private"
        ) {
          const relayResult = await relayOnce({
            destination: relayDestination,
            deliveryId,
            githubEvent,
            signature,
            rawBody,
          });
          if (relayResult === "conflict") return conflict(event);
          if (relayResult === "unavailable") {
            console.error("GitHub webhook relay unavailable");
            return unavailable(event, true);
          }
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
    destination: Extract<GitHubWebhookRelayDestination, { kind: "private" }>;
    deliveryId: string;
    githubEvent: string;
    signature: string;
    rawBody: ArrayBuffer;
  }): Promise<RelayResult> {
    const relayKey = `${input.destination.url.href}\n${input.deliveryId}`;
    const payloadSha256 = createHash("sha256")
      .update(new Uint8Array(input.rawBody))
      .digest("hex");
    const completedPayloadSha256 = completedRelays.get(relayKey);
    if (completedPayloadSha256 !== undefined) {
      return completedPayloadSha256 === payloadSha256 ? "accepted" : "conflict";
    }
    const activeRelay = activeRelays.get(relayKey);
    if (activeRelay) {
      return activeRelay.payloadSha256 === payloadSha256
        ? activeRelay.result
        : "conflict";
    }

    const attempt = sendRelay(input);
    activeRelays.set(relayKey, { payloadSha256, result: attempt });
    try {
      const result = await attempt;
      if (result === "accepted") {
        rememberCompletedRelay(relayKey, payloadSha256);
      }
      return result;
    } finally {
      activeRelays.delete(relayKey);
    }
  }

  async function sendRelay(input: {
    destination: Extract<GitHubWebhookRelayDestination, { kind: "private" }>;
    deliveryId: string;
    githubEvent: string;
    signature: string;
    rawBody: ArrayBuffer;
  }): Promise<RelayResult> {
    try {
      const response = await relayFetch(input.destination.url, {
        method: "POST",
        headers: {
          "X-GitHub-Delivery": input.deliveryId,
          "X-GitHub-Event": input.githubEvent,
          "X-Hub-Signature-256": input.signature,
        },
        body: input.rawBody,
        signal: AbortSignal.timeout(relayTimeoutMs),
      });
      if (response.status === 409) return "conflict";
      return response.ok ? "accepted" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  function rememberCompletedRelay(
    relayKey: string,
    payloadSha256: string,
  ): void {
    completedRelays.set(relayKey, payloadSha256);
    if (completedRelays.size <= MAX_COMPLETED_RELAY_DELIVERIES) return;
    const oldestRelayKey = completedRelays.keys().next().value;
    if (oldestRelayKey !== undefined) completedRelays.delete(oldestRelayKey);
  }
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

function conflict(event: H3Event) {
  setResponseStatus(event, 409);
  return { status: "conflict" as const };
}

export default createGitHubWebhookRoute();
