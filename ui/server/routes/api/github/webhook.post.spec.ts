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
  expectedReviewerLogin: "review-app[bot]",
  installationId: 42,
};
const privateRelayUrl = "http://127.0.0.1:4187/webhooks/github";

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
      loadRelayDestination: () => undefined,
      receive: (input, loadedConfig) =>
        service.receiveGitHubWebhook(input, loadedConfig),
    }),
  );
}

function signatureFor(rawBody: string): string {
  return `sha256=${createHmac("sha256", config.webhookSecret)
    .update(rawBody)
    .digest("hex")}`;
}

function signedRawRequest(
  rawBody: string,
  deliveryId: string,
  event: string,
) {
  return {
    method: "POST",
    headers: {
      ...requestHeaders(),
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signatureFor(rawBody),
    },
    body: rawBody,
  };
}

function signedRequest(
  payload: object,
  deliveryId: string,
  event: GithubTriggerEvent = "issues",
) {
  const rawBody = JSON.stringify(payload);
  return signedRawRequest(rawBody, deliveryId, event);
}

describe("POST /api/github/webhook", () => {
  test("relays a signed pull request byte-for-byte after local intake", async () => {
    const service = createService();
    await createEnabledAgent(service, [], "pull_request", "opened");
    const relayFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 202 }),
    );
    const app = new H3().post(
      "/api/github/webhook",
      createGitHubWebhookRoute({
        loadConfig: () => config,
        loadRelayDestination: () => privateRelayUrl,
        receive: (input, loadedConfig) =>
          service.receiveGitHubWebhook(input, loadedConfig),
        relayFetch,
      }),
    );
    const rawBody = ` {\n  "action": "opened",\n  "repository": { "full_name": "dallascrilley/shipwright" },\n  "number": 7,\n  "pull_request": { "number": 7, "base": { "ref": "main" }, "draft": false, "labels": [] }\n}\n`;
    const signature = signatureFor(rawBody);

    const response = await app.request(
      "/api/github/webhook",
      signedRawRequest(rawBody, "delivery-relay-pr", "pull_request"),
    );

    expect(response.status).toBe(202);
    expect(service.getSnapshot().queueEntries).toHaveLength(1);
    expect(relayFetch).toHaveBeenCalledTimes(1);
    const relayCall = relayFetch.mock.calls[0];
    expect(relayCall).toBeDefined();
    if (!relayCall) throw new Error("missing relay call");
    expect(relayCall[0].toString()).toBe(privateRelayUrl);
    const headers = new Headers(relayCall[1]?.headers);
    expect(headers.get("x-github-delivery")).toBe("delivery-relay-pr");
    expect(headers.get("x-github-event")).toBe("pull_request");
    expect(headers.get("x-hub-signature-256")).toBe(signature);
    await expect(new Response(relayCall[1]?.body).text()).resolves.toBe(rawBody);
  });

  test("relays check suites without invoking local queue intake", async () => {
    const receive = vi.fn(async () => ({
      status: "accepted" as const,
      matched: 0,
      conditionFiltered: 0,
      decisions: [],
      decisionsTruncated: 0,
    }));
    const relayFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 202 }),
    );
    const app = new H3().post(
      "/api/github/webhook",
      createGitHubWebhookRoute({
        loadConfig: () => config,
        loadRelayDestination: () => privateRelayUrl,
        receive,
        relayFetch,
      }),
    );
    const rawBody = `{"check_suite":{"id":91},"action":"completed","repository":{"full_name":"dallascrilley/shipwright"}}\n`;

    const response = await app.request(
      "/api/github/webhook",
      signedRawRequest(rawBody, "delivery-check-suite", "check_suite"),
    );

    expect(response.status).toBe(202);
    expect(receive).not.toHaveBeenCalled();
    expect(relayFetch).toHaveBeenCalledTimes(1);
    const relayCall = relayFetch.mock.calls[0];
    expect(relayCall).toBeDefined();
    if (!relayCall) throw new Error("missing relay call");
    const headers = new Headers(relayCall[1]?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(relayCall[1]?.redirect).toBe("error");
    await expect(new Response(relayCall[1]?.body).text()).resolves.toBe(rawBody);
  });

  test("does not relay pull requests from a disallowed repository", async () => {
    const receive = vi.fn(async () => ({
      status: "accepted" as const,
      matched: 0,
      conditionFiltered: 0,
      decisions: [],
      decisionsTruncated: 0,
    }));
    const relayFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    const app = new H3().post(
      "/api/github/webhook",
      createGitHubWebhookRoute({
        loadConfig: () => config,
        loadRelayDestination: () => privateRelayUrl,
        receive,
        relayFetch,
      }),
    );

    const response = await app.request(
      "/api/github/webhook",
      signedRequest(
        {
          action: "opened",
          repository: { full_name: "someoneelse/repository" },
          number: 7,
          pull_request: {
            number: 7,
            base: { ref: "main" },
            draft: false,
            labels: [],
          },
        },
        "delivery-disallowed-pr",
        "pull_request",
      ),
    );

    expect(response.status).toBe(202);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(relayFetch).not.toHaveBeenCalled();
  });

  test.each([
    [
      "malformed",
      '{"check_suite":{"id":91},"action":"completed"}\n',
      400,
    ],
    [
      "disallowed repository",
      '{"check_suite":{"id":91},"action":"completed","repository":{"full_name":"someoneelse/repository"}}\n',
      202,
    ],
  ] as const)("does not relay %s check suites", async (_name, rawBody, status) => {
    const receive = vi.fn();
    const relayFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    const app = new H3().post(
      "/api/github/webhook",
      createGitHubWebhookRoute({
        loadConfig: () => config,
        loadRelayDestination: () => privateRelayUrl,
        receive,
        relayFetch,
      }),
    );

    const response = await app.request(
      "/api/github/webhook",
      signedRawRequest(
        rawBody,
        `delivery-check-suite-${_name.replace(" ", "-")}`,
        "check_suite",
      ),
    );

    expect(response.status).toBe(status);
    expect(receive).not.toHaveBeenCalled();
    expect(relayFetch).not.toHaveBeenCalled();
  });

  test("keeps check suites rejected when the private relay is disabled", async () => {
    const receive = vi.fn(async () => ({
      status: "rejected" as const,
      reason: "invalid_payload" as const,
    }));
    const relayFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    const app = new H3().post(
      "/api/github/webhook",
      createGitHubWebhookRoute({
        loadConfig: () => config,
        receive,
        relayFetch,
      }),
    );

    const response = await app.request(
      "/api/github/webhook",
      signedRawRequest(
        '{"check_suite":{"id":91},"action":"completed"}\n',
        "delivery-check-suite-disabled",
        "check_suite",
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      status: "rejected",
      reason: "invalid_payload",
    });
    expect(receive).toHaveBeenCalledTimes(1);
    expect(relayFetch).not.toHaveBeenCalled();
  });

  test("rejects an invalid signature before local or relay effects", async () => {
    const service = createService();
    await createEnabledAgent(service, [], "pull_request", "opened");
    const receive = vi.fn((input, loadedConfig) =>
      service.receiveGitHubWebhook(input, loadedConfig),
    );
    const relayFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    const app = new H3().post(
      "/api/github/webhook",
      createGitHubWebhookRoute({
        loadConfig: () => config,
        loadRelayDestination: () => privateRelayUrl,
        receive,
        relayFetch,
      }),
    );

    const response = await app.request("/api/github/webhook", {
      method: "POST",
      headers: {
        ...requestHeaders(),
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-invalid-signature",
      },
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(receive).not.toHaveBeenCalled();
    expect(relayFetch).not.toHaveBeenCalled();
    expect(service.getSnapshot().queueEntries).toHaveLength(0);
  });

  test("returns retryable failures for a timeout and Symphony 5xx receipt before later 202 acceptance", async () => {
    const service = createService();
    const { agent, trigger } = await createEnabledAgent(
      service,
      [],
      "pull_request",
      "opened",
    );
    let attempt = 0;
    const relayFetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) => {
        attempt += 1;
        if (attempt === 1) {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error("relay timeout signal missing");
            signal.addEventListener(
              "abort",
              () => reject(new Error("relay timed out")),
              { once: true },
            );
          });
        }
        return Promise.resolve(
          new Response(null, { status: attempt === 2 ? 502 : 202 }),
        );
      },
    );
    const app = new H3().post(
      "/api/github/webhook",
      createGitHubWebhookRoute({
        loadConfig: () => config,
        loadRelayDestination: () => privateRelayUrl,
        receive: (input, loadedConfig) =>
          service.receiveGitHubWebhook(input, loadedConfig),
        relayFetch,
        relayTimeoutMs: 5,
      }),
    );
    const init = signedRequest(
      {
        action: "opened",
        repository: { full_name: "dallascrilley/shipwright" },
        number: 7,
        pull_request: {
          number: 7,
          base: { ref: "main" },
          draft: false,
          labels: [],
        },
      },
      "delivery-retry-relay",
      "pull_request",
    );

    const timedOut = await app.request("/api/github/webhook", init);
    expect(timedOut.status).toBe(503);
    expect(timedOut.headers.get("retry-after")).toBe("10");

    const definition = service.exportAgentDefinition(agent.agentId);
    const updatedAgent = await service.saveAgent({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      draft: {
        ...definition.configuration,
        instructions: `${definition.configuration.instructions} Updated.`,
      },
    });
    service.replaceTrigger({
      agentId: agent.agentId,
      expectedRevision: updatedAgent.currentRevision,
      triggerId: trigger.triggerId,
      kind: "github",
      config: { event: "pull_request", actions: ["opened"], conditions: [] },
    });

    const rejected = await app.request("/api/github/webhook", init);
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("retry-after")).toBe("10");
    expect((await app.request("/api/github/webhook", init)).status).toBe(202);

    expect(relayFetch).toHaveBeenCalledTimes(3);
    expect(service.getSnapshot().queueEntries).toHaveLength(1);
    expect(service.getSnapshot().executions).toHaveLength(1);
  });

  test("cancels a successful relay response body", async () => {
    const service = createService();
    await createEnabledAgent(service, [], "pull_request", "opened");
    let cancelled = false;
    const relayFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 202 },
        ),
    );
    const app = new H3().post(
      "/api/github/webhook",
      createGitHubWebhookRoute({
        loadConfig: () => config,
        loadRelayDestination: () => privateRelayUrl,
        receive: (input, loadedConfig) =>
          service.receiveGitHubWebhook(input, loadedConfig),
        relayFetch,
      }),
    );

    const response = await app.request(
      "/api/github/webhook",
      signedRequest(
        {
          action: "opened",
          repository: { full_name: "dallascrilley/shipwright" },
          number: 7,
          pull_request: {
            number: 7,
            base: { ref: "main" },
            draft: false,
            labels: [],
          },
        },
        "delivery-response-body",
        "pull_request",
      ),
    );

    expect(response.status).toBe(202);
    expect(cancelled).toBe(true);
  });

  test("replays a successful pull request without duplicate local or relay work", async () => {
    const service = createService();
    await createEnabledAgent(service, [], "pull_request", "opened");
    const relayFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 202 }),
    );
    const app = new H3().post(
      "/api/github/webhook",
      createGitHubWebhookRoute({
        loadConfig: () => config,
        loadRelayDestination: () => privateRelayUrl,
        receive: (input, loadedConfig) =>
          service.receiveGitHubWebhook(input, loadedConfig),
        relayFetch,
      }),
    );
    const init = signedRequest(
      {
        action: "opened",
        repository: { full_name: "dallascrilley/shipwright" },
        number: 7,
        pull_request: {
          number: 7,
          base: { ref: "main" },
          draft: false,
          labels: [],
        },
      },
      "delivery-relay-replay",
      "pull_request",
    );

    expect((await app.request("/api/github/webhook", init)).status).toBe(202);
    expect((await app.request("/api/github/webhook", init)).status).toBe(202);

    expect(service.getSnapshot().queueEntries).toHaveLength(1);
    expect(relayFetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    "not a URL",
    "https://example.com/webhooks/github",
    "http://private.internal/webhooks/github",
    "http://symphony/webhooks/github",
    "http://127.0.0.1:4187/not-github",
  ])("rejects configured non-private relay destination %s", async (destination) => {
    const receive = vi.fn(async () => ({
      status: "accepted" as const,
      matched: 0,
      conditionFiltered: 0,
      decisions: [],
      decisionsTruncated: 0,
    }));
    const relayFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    const app = new H3().post(
      "/api/github/webhook",
      createGitHubWebhookRoute({
        loadConfig: () => config,
        loadRelayDestination: () => destination,
        receive,
        relayFetch,
      }),
    );
    const rawBody = "{}";

    const response = await app.request(
      "/api/github/webhook",
      signedRawRequest(rawBody, "delivery-bad-destination", "issues"),
    );

    expect(response.status).toBe(503);
    expect(receive).not.toHaveBeenCalled();
    expect(relayFetch).not.toHaveBeenCalled();
  });

  test.each([0, -1, 5_001, 1.5])(
    "rejects an unbounded relay timeout %s",
    (relayTimeoutMs) => {
      expect(() =>
        createGitHubWebhookRoute({ relayTimeoutMs }),
      ).toThrow("GitHub webhook relay timeout must be between 1 and 5000 milliseconds");
    },
  );

  test("a signed delivery queues once and its replay leaves the durable queue unchanged", async () => {
    const service = createService();
    await createEnabledAgent(service);
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
      "github:delivery-1:1",
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
      sender: { login: "review-app[bot]" },
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
      idempotencyKey: "github:delivery-review-route:1",
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
          sender: { login: "review-app[bot]" },
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
      createGitHubWebhookRoute({
        loadConfig: () => config,
        loadRelayDestination: () => undefined,
        receive,
      }),
    );
    const rawBody = JSON.stringify({
      action: "opened",
      repository: { full_name: "dallascrilley/shipwright" },
      issue: { number: 42 },
    });

    const response = await app.request(
      "/api/github/webhook",
      signedRawRequest(rawBody, "delivery-1", "issues"),
    );

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
        signature: signatureFor(rawBody),
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
          loadRelayDestination: () => undefined,
          receive: async () => ({ status: "rejected", reason }),
        }),
      );

      const response = await app.request(
        "/api/github/webhook",
        signedRawRequest("{}", "delivery-1", "issues"),
      );

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
      createGitHubWebhookRoute({
        loadConfig: () => config,
        loadRelayDestination: () => undefined,
        receive,
      }),
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
        loadRelayDestination: () => undefined,
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
