import { createHmac } from "node:crypto";

import { H3 } from "h3";
import { describe, expect, test, vi } from "vitest";

import { MemoryAgentControlPlaneStore } from "../../../agent-control-plane";
import { AgentManagementService } from "../../../agent-management";
import { createGitHubWebhookRoute } from "./webhook.post";

const config = {
  webhookSecret: "w".repeat(32),
  allowedRepositories: new Set(["dallascrilley/shipwright"]),
  allowedOwners: new Set(["dallascrilley"]),
};

function requestHeaders() {
  return {
    "content-type": "application/json",
    "x-github-event": "issues",
    "x-github-delivery": "delivery-1",
    "x-hub-signature-256": `sha256=${"a".repeat(64)}`,
  };
}

describe("POST /api/github/webhook", () => {
  test("a signed delivery queues once and its replay leaves the durable queue unchanged", async () => {
    let sequence = 0;
    const service = new AgentManagementService({
      store: new MemoryAgentControlPlaneStore(),
      createId: () => `id-${++sequence}`,
      now: () => "2026-07-22T17:00:00.000Z",
      repositoryCatalog: {
        assertSelectable: async () => ({
          repository: "dallascrilley/shipwright",
          owner: "dallascrilley",
          name: "shipwright",
          defaultBranch: "main",
          visibility: "private",
          archived: false,
          selectable: true,
        }),
      },
    });
    const agent = await service.createAgent({
      name: "Issue triage",
      instructions: "Triage the issue as a dry run.",
      skillId: "fix-review-findings",
      allowedTools: ["github"],
      targetScope: { repository: "dallascrilley/shipwright" },
      verification: { presetId: "bun-test" },
      publicationPolicy: "dry_run",
    });
    service.createTrigger({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      kind: "github",
      config: { event: "issues", actions: ["opened"] },
    });
    service.setAgentEnabled({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      enabled: true,
    });
    const app = new H3().post(
      "/api/github/webhook",
      createGitHubWebhookRoute({
        loadConfig: () => config,
        receive: (input, loadedConfig) =>
          service.receiveGitHubWebhook(input, loadedConfig),
      }),
    );
    const rawBody = JSON.stringify({
      action: "opened",
      repository: { full_name: "dallascrilley/shipwright" },
      issue: { number: 42 },
    });
    const signature = `sha256=${createHmac("sha256", config.webhookSecret)
      .update(rawBody)
      .digest("hex")}`;
    const init = {
      method: "POST",
      headers: { ...requestHeaders(), "x-hub-signature-256": signature },
      body: rawBody,
    };

    expect((await app.request("/api/github/webhook", init)).status).toBe(202);
    expect((await app.request("/api/github/webhook", init)).status).toBe(202);
    expect(service.getSnapshot().queueEntries).toHaveLength(1);
    expect(service.getSnapshot().executions[0]?.idempotencyKey).toBe(
      `github:delivery-1:${agent.currentRevision}`,
    );
  });

  test("passes the untouched body and GitHub headers to the shared ingress", async () => {
    const receive = vi.fn(async () => ({
      status: "accepted" as const,
      matched: 1,
      conditionFiltered: 0,
      decisions: [],
      decisionsTruncated: 0,
    }));
    const app = new H3().post(
      "/api/github/webhook",
      createGitHubWebhookRoute({ loadConfig: () => config, receive }),
    );
    const rawBody = JSON.stringify({
      action: "opened",
      repository: { full_name: "dallascrilley/shipwright" },
      issue: { number: 42 },
    });

    const response = await app.request("/api/github/webhook", {
      method: "POST",
      headers: requestHeaders(),
      body: rawBody,
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      status: "accepted",
      matched: 1,
      conditionFiltered: 0,
      decisions: [],
      decisionsTruncated: 0,
    });
    expect(receive).toHaveBeenCalledWith(
      {
        event: "issues",
        deliveryId: "delivery-1",
        rawBody,
        signature: `sha256=${"a".repeat(64)}`,
      },
      config,
    );
  });

  test.each([
    ["invalid_signature", 401],
    ["invalid_payload", 400],
  ] as const)(
    "maps %s to a fixed non-success response",
    async (reason, status) => {
      const app = new H3().post(
        "/api/github/webhook",
        createGitHubWebhookRoute({
          loadConfig: () => config,
          receive: async () => ({ status: "rejected", reason }),
        }),
      );

      const response = await app.request("/api/github/webhook", {
        method: "POST",
        headers: requestHeaders(),
        body: "{}",
      });

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({
        status: "rejected",
        reason,
      });
    },
  );

  test("rejects an oversized body before invoking the ingress", async () => {
    const receive = vi.fn();
    const app = new H3().post(
      "/api/github/webhook",
      createGitHubWebhookRoute({ loadConfig: () => config, receive }),
    );

    const response = await app.request("/api/github/webhook", {
      method: "POST",
      headers: requestHeaders(),
      body: "x".repeat(1_048_577),
    });

    expect(response.status).toBe(413);
    expect(receive).not.toHaveBeenCalled();
  });

  test("fails closed without leaking configuration details", async () => {
    const receive = vi.fn();
    const app = new H3().post(
      "/api/github/webhook",
      createGitHubWebhookRoute({
        loadConfig: () => {
          throw new Error("secret configuration detail");
        },
        receive,
      }),
    );

    const response = await app.request("/api/github/webhook", {
      method: "POST",
      headers: requestHeaders(),
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret configuration detail");
    expect(receive).not.toHaveBeenCalled();
  });
});
