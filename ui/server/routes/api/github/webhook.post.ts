import { assertBodySize, defineEventHandler, setResponseStatus } from "h3";

import {
  parseGitHubWebhookConfig,
  type GitHubWebhookConfig,
} from "../../../../../src/config/github.js";
import { getAgentManagementService } from "../../../agent-management";
import {
  MAX_WEBHOOK_BODY_BYTES,
  type GitHubWebhookInput,
  type GitHubWebhookResult,
} from "../../../github-webhook";

export interface GitHubWebhookRouteDependencies {
  loadConfig?: () => GitHubWebhookConfig;
  receive?: (
    input: GitHubWebhookInput,
    config: GitHubWebhookConfig,
  ) => Promise<GitHubWebhookResult>;
}

/** Public HTTP adapter for GitHub App deliveries; signature checks stay in the ingress. */
export function createGitHubWebhookRoute(
  dependencies: GitHubWebhookRouteDependencies = {},
) {
  const loadConfig =
    dependencies.loadConfig ?? (() => parseGitHubWebhookConfig());
  const receive =
    dependencies.receive ??
    ((input, config) =>
      getAgentManagementService().receiveGitHubWebhook(input, config));

  return defineEventHandler(async (event) => {
    await assertBodySize(event, MAX_WEBHOOK_BODY_BYTES);
    const rawBody = await event.req.text();
    const input: GitHubWebhookInput = {
      event: event.req.headers.get("x-github-event") ?? "",
      deliveryId: event.req.headers.get("x-github-delivery") ?? "",
      signature: event.req.headers.get("x-hub-signature-256") ?? "",
      rawBody,
    };

    try {
      const result = await receive(input, loadConfig());
      if (result.status === "accepted") {
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
      setResponseStatus(event, 503);
      return { status: "unavailable" };
    }
  });
}

export default createGitHubWebhookRoute();
