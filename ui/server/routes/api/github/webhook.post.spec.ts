import { createHmac } from "node:crypto";

import { H3 } from "h3";
import { describe, expect, test, vi } from "vitest";

import type {
  GithubTriggerCondition,
  GithubTriggerEvent,
} from "../../../../shared/agent-definition";
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

function createService() {
  let sequence = 0;
  return new AgentManagementService({
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
}

async function createEnabledAgent(
  service: AgentManagementService,
  conditions: GithubTriggerCondition[] = [],
  event: GithubTriggerEvent = "issues",
  action: string = "opened",
) {
  const actionPreset =
    event === "issues" ? ("fix_issue" as const) : ("resolve_pr_feedback" as const);
  const agent = await service.createAgent({
    name: event === "issues" ? "Issue triage" : "PR feedback",
    instructions:
      event === "issues"
        ? "Triage the issue as a dry run."
        : "Resolve pull request feedback as a dry run.",
    actionPreset,
    skillId: event === "issues" ? "" : "fix-review-findings",
    allowedTools: ["github", "sandbox"],
    targetScope: { repository: "dallascrilley/shipwright" },
    verification: { presetId: "bun-test" },
    publicationPolicy: "dry_run",
  });
  const trigger = service.createTrigger({
    agentId: agent.agentId,
    expectedRevision: agent.currentRevision,
    kind: "github",
    config: { event, actions: [action], conditions },
  });
  service.setAgentEnabled({
    agentId: agent.agentId,
    expectedRevision: agent.currentRevision,
    enabled: true,
  });
  return { agent, trigger };
}

function createApp(service: AgentManagementService) {
  return new H3().post(
    "/api/github/webhook",
    createGitHubWebhookRoute({
      loadConfig: () => config,
      receive: (input, loadedConfig) =>
        service.receiveGitHubWebhook(input, loadedConfig),
    }),
  );
}

function signedRequest(
  payload: object,
  deliveryId: string,
  event: GithubTriggerEvent = "issues",
) {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", config.webhookSecret)
    .update(rawBody)
    .digest("hex")}`;
  return {
    method: "POST",
    headers: {
      ...requestHeaders(),
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    },
    body: rawBody,
  };
}

describe("POST /api/github/webhook", () => {
  test("a signed delivery queues once and its replay leaves the durable queue unchanged", async () => {
    const service = createService();
    const { agent } = await createEnabledAgent(service);
    const app = createApp(service);
    const payload = {
      action: "opened",
      repository: { full_name: "dallascrilley/shipwright" },
      issue: { number: 42 },
    };
    const init = signedRequest(payload, "delivery-1");

    expect((await app.request("/api/github/webhook", init)).status).toBe(202);
    expect((await app.request("/api/github/webhook", init)).status).toBe(202);
    expect(service.getSnapshot().queueEntries).toHaveLength(1);
    expect(service.getSnapshot().executions[0]?.idempotencyKey).toBe(
      `github:delivery-1:${agent.currentRevision}`,
    );
  });

  test("a submitted App review validates provenance before queueing and replay remains idempotent", async () => {
    const service = createService();
    const { agent, trigger } = await createEnabledAgent(
      service,
      [],
      "pull_request_review",
      "submitted",
    );
    const app = createApp(service);
    const payload = {
      action: "submitted",
      repository: { full_name: "dallascrilley/shipwright" },
      installation: { id: 42 },
      review: {
        id: 501,
        user: { login: "review-app[bot]", type: "Bot" },
        commit_id: "head-sha",
        body: "untrusted-review-body-marker",
      },
      pull_request: {
        number: 7,
        head: { sha: "head-sha" },
        base: { ref: "main" },
        draft: false,
        labels: [],
      },
    };
    const init = signedRequest(payload, "delivery-review-route", "pull_request_review");

    const first = await app.request("/api/github/webhook", init);
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({
      status: "accepted",
      matched: 1,
      conditionFiltered: 0,
    });
    expect(service.getSnapshot().queueEntries).toHaveLength(1);
    expect(service.getSnapshot().executions[0]).toMatchObject({
      agentRevision: trigger.agentRevision,
      idempotencyKey: `github:delivery-review-route:${trigger.agentRevision}`,
      target: { kind: "pull", number: 7 },
    });
    expect(service.getSnapshot().revisions[0]?.draft.publicationPolicy).toBe(
      "dry_run",
    );
    expect(JSON.stringify(service.getSnapshot())).not.toContain(
      "untrusted-review-body-marker",
    );

    expect((await app.request("/api/github/webhook", init)).status).toBe(202);
    expect(service.getSnapshot().queueEntries).toHaveLength(1);
    expect(agent.currentRevision).toBe(trigger.agentRevision);
  });

  test("rejects a submitted review with a mismatched head before the route can queue it", async () => {
    const service = createService();
    await createEnabledAgent(service, [], "pull_request_review", "submitted");
    const app = createApp(service);
    const response = await app.request(
      "/api/github/webhook",
      signedRequest(
        {
          action: "submitted",
          repository: { full_name: "dallascrilley/shipwright" },
          installation: { id: 42 },
          review: {
            id: 502,
            user: { login: "review-app[bot]", type: "Bot" },
            commit_id: "reviewed-sha",
          },
          pull_request: {
            number: 7,
            head: { sha: "current-head-sha" },
            base: { ref: "main" },
            draft: false,
            labels: [],
          },
        },
        "delivery-review-mismatch",
        "pull_request_review",
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      status: "rejected",
      reason: "invalid_payload",
    });
    expect(service.getSnapshot().queueEntries).toHaveLength(0);
  });

  test("signed condition deliveries match or fail closed with safe evidence", async () => {
    const service = createService();
    const { trigger } = await createEnabledAgent(service, [
      { field: "actor", operator: "is_one_of", values: ["alice"] },
      { field: "labels", operator: "include_all", values: ["bug", "urgent"] },
    ]);
    const app = createApp(service);
    const basePayload = {
      action: "opened",
      repository: { full_name: "dallascrilley/shipwright" },
      sender: { login: "Alice" },
      issue: {
        number: 42,
        title: "private-title-marker",
        body: "private-body-marker",
        labels: [{ name: "BUG" }, { name: "Urgent" }],
      },
    };

    const match = await app.request(
      "/api/github/webhook",
      signedRequest(basePayload, "delivery-condition-match"),
    );
    expect(match.status).toBe(202);
    await expect(match.json()).resolves.toEqual({
      status: "accepted",
      matched: 1,
      conditionFiltered: 0,
      decisions: [
        { triggerId: trigger.triggerId, decision: "matched", reasonCodes: [] },
      ],
      decisionsTruncated: 0,
    });

    for (const [deliveryId, payload, reasonCode] of [
      [
        "delivery-condition-mismatch",
        {
          ...basePayload,
          issue: { ...basePayload.issue, labels: [{ name: "bug" }] },
        },
        "labels_mismatch",
      ],
      [
        "delivery-condition-missing",
        { ...basePayload, sender: undefined },
        "actor_missing",
      ],
      [
        "delivery-condition-malformed",
        {
          ...basePayload,
          issue: { ...basePayload.issue, labels: [{ name: 42 }] },
        },
        "labels_malformed",
      ],
    ] as const) {
      const response = await app.request(
        "/api/github/webhook",
        signedRequest(payload, deliveryId),
      );
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        status: "accepted",
        matched: 0,
        conditionFiltered: 1,
        decisions: [
          {
            triggerId: trigger.triggerId,
            decision: "filtered",
            reasonCodes: [reasonCode],
          },
        ],
        decisionsTruncated: 0,
      });
    }

    const snapshotText = JSON.stringify(service.getSnapshot());
    expect(service.getSnapshot().queueEntries).toHaveLength(1);
    expect(service.getSnapshot().revisions[0]?.draft.publicationPolicy).toBe(
      "dry_run",
    );
    expect(snapshotText).not.toContain("private-title-marker");
    expect(snapshotText).not.toContain("private-body-marker");
  });

  test("matching alternatives queue once, replay once, and expose no observed values", async () => {
    const service = createService();
    const { agent, trigger: firstPullTrigger } = await createEnabledAgent(
      service,
      [{ field: "draft_state", operator: "is_not_draft" }],
      "pull_request",
      "opened",
    );
    const alternative = service.createTrigger({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      kind: "github",
      config: {
        event: "pull_request",
        actions: ["opened"],
        conditions: [{ field: "draft_state", operator: "is_not_draft" }],
      },
    });

    const app = createApp(service);
    const payload = {
      action: "opened",
      repository: { full_name: "dallascrilley/shipwright" },
      sender: { login: "observed-actor-marker" },
      number: 7,
      pull_request: {
        number: 7,
        title: "observed-title-marker",
        body: "observed-body-marker",
        labels: [{ name: "observed-label-marker" }],
        base: { ref: "observed-branch-marker" },
        draft: false,
      },
    };
    const init = signedRequest(
      payload,
      "delivery-overlapping-route",
      "pull_request",
    );

    const response = await app.request("/api/github/webhook", init);
    expect(response.status).toBe(202);
    const result = await response.json();
    expect(result).toMatchObject({
      status: "accepted",
      matched: 1,
      conditionFiltered: 0,
      decisionsTruncated: 0,
    });
    expect(result.decisions).toHaveLength(2);
    expect(
      result.decisions
        .map(({ triggerId }: { triggerId: string }) => triggerId)
        .sort(),
    ).toEqual([alternative.triggerId, firstPullTrigger.triggerId].sort());
    expect(JSON.stringify(result)).not.toContain("observed-");

    expect((await app.request("/api/github/webhook", init)).status).toBe(202);
    expect(service.getSnapshot().queueEntries).toHaveLength(1);
    expect(JSON.stringify(service.getSnapshot())).not.toContain("observed-");
  });
  test("caps signed route decision evidence while evaluating every alternative", async () => {
    const service = createService();
    const { agent } = await createEnabledAgent(service, [
      { field: "actor", operator: "is_one_of", values: ["allowed"] },
    ]);
    for (let index = 0; index < 21; index += 1) {
      service.createTrigger({
        agentId: agent.agentId,
        expectedRevision: agent.currentRevision,
        kind: "github",
        config: {
          event: "issues",
          actions: ["opened"],
          conditions: [
            { field: "actor", operator: "is_one_of", values: ["allowed"] },
          ],
        },
      });
    }
    const app = createApp(service);
    const response = await app.request(
      "/api/github/webhook",
      signedRequest(
        {
          action: "opened",
          repository: { full_name: "dallascrilley/shipwright" },
          sender: { login: "observed-rejected-actor" },
          issue: { number: 42, labels: [] },
        },
        "delivery-capped-route",
      ),
    );
    const result = await response.json();

    expect(response.status).toBe(202);
    expect(result).toMatchObject({
      status: "accepted",
      matched: 0,
      conditionFiltered: 22,
      decisionsTruncated: 2,
    });
    expect(result.decisions).toHaveLength(20);
    expect(JSON.stringify(result)).not.toContain("observed-rejected-actor");
    expect(service.getSnapshot().queueEntries).toHaveLength(0);
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
