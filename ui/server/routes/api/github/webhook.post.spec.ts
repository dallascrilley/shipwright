import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { env } from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

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
const EXPECTED_SYMPHONY_COMMIT = "61e941bbec3f9de9ed07ecaf440ec4be4b8c2149";
const symphonyCheckout = env.SHIPWRIGHT_TEST_SYMPHONY_CHECKOUT ?? "";
const symphonyPython = env.SHIPWRIGHT_TEST_PYTHON ?? "python3";
const symphonyHarness = fileURLToPath(
  new URL("./fixtures/symphony-webhook-harness.py", import.meta.url),
);

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
    event === "issues"
      ? ("fix_issue" as const)
      : ("resolve_pr_feedback" as const);
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

function signedRawRequest(rawBody: string, deliveryId: string, event: string) {
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

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to reserve a loopback port");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function startSymphonyHarness(input: {
  workflowPath: string;
  port: number;
}): Promise<{ child: ChildProcess; stateDb: string }> {
  const pythonPath = [join(symphonyCheckout, "src"), env.PYTHONPATH]
    .filter((part): part is string => Boolean(part))
    .join(delimiter);
  const child = spawn(
    symphonyPython,
    [
      symphonyHarness,
      input.workflowPath,
      String(input.port),
      config.webhookSecret,
      "dallascrilley/shipwright",
      String(config.installationId),
    ],
    {
      env: { ...env, PYTHONPATH: pythonPath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const lines = createInterface({ input: child.stdout! });
  const line = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Symphony harness start timed out: ${stderr}`)),
      5_000,
    );
    lines.once("line", (value) => {
      clearTimeout(timeout);
      resolve(value);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Symphony harness exited ${code}: ${stderr}`));
    });
  });
  lines.close();
  const startup = JSON.parse(line) as { port: number; state_db: string };
  expect(startup.port).toBe(input.port);
  return { child, stateDb: startup.state_db };
}

async function stopSymphonyHarness(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Symphony harness did not stop after SIGTERM"));
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe("POST /api/github/webhook", () => {
  test("relays a signed pull request byte-for-byte after local intake", async () => {
    const service = createService();
    await createEnabledAgent(service, [], "pull_request", "opened");
    const relayFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
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
    await expect(new Response(relayCall[1]?.body).text()).resolves.toBe(
      rawBody,
    );
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
    const rawBody = `{"check_suite":{"id":91},"action":"completed"}\n`;

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
    await expect(new Response(relayCall[1]?.body).text()).resolves.toBe(
      rawBody,
    );
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

  test("returns retryable failures for a timeout and non-2xx before later success", async () => {
    const service = createService();
    await createEnabledAgent(service, [], "pull_request", "opened");
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
          new Response(null, { status: attempt === 2 ? 502 : 204 }),
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
    const rejected = await app.request("/api/github/webhook", init);
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("retry-after")).toBe("10");
    expect((await app.request("/api/github/webhook", init)).status).toBe(202);

    expect(relayFetch).toHaveBeenCalledTimes(3);
    expect(service.getSnapshot().queueEntries).toHaveLength(1);
  });

  test("replays a successful pull request without duplicate local or relay work", async () => {
    const service = createService();
    await createEnabledAgent(service, [], "pull_request", "opened");
    const relayFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
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

  test("rejects a changed payload that reuses a completed relay delivery id", async () => {
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
    const originalBody = JSON.stringify({
      action: "opened",
      repository: { full_name: "dallascrilley/shipwright" },
      number: 7,
      pull_request: {
        number: 7,
        base: { ref: "main" },
        draft: false,
        labels: [],
      },
    });
    const changedBody = `${originalBody.slice(0, -1)},"changed":true}`;

    const accepted = await app.request(
      "/api/github/webhook",
      signedRawRequest(originalBody, "delivery-relay-conflict", "pull_request"),
    );
    const conflict = await app.request(
      "/api/github/webhook",
      signedRawRequest(changedBody, "delivery-relay-conflict", "pull_request"),
    );

    expect(accepted.status).toBe(202);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ status: "conflict" });
    expect(relayFetch).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().queueEntries).toHaveLength(1);
  });

  test("preserves a downstream Symphony delivery conflict as 409", async () => {
    const service = createService();
    await createEnabledAgent(service, [], "pull_request", "opened");
    const relayFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ status: "conflict" }), { status: 409 }),
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
        "delivery-downstream-conflict",
        "pull_request",
      ),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBeNull();
    await expect(response.json()).resolves.toEqual({ status: "conflict" });
    expect(relayFetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    "not a URL",
    "https://example.com/webhooks/github",
    "http://private.internal/webhooks/github",
    "http://symphony/webhooks/github",
    "http://127.0.0.1:4187/not-github",
  ])(
    "rejects configured non-private relay destination %s",
    async (destination) => {
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
    },
  );

  test.each([0, -1, 5_001, 1.5])(
    "rejects an unbounded relay timeout %s",
    (relayTimeoutMs) => {
      expect(() => createGitHubWebhookRoute({ relayTimeoutMs })).toThrow(
        "GitHub webhook relay timeout must be between 1 and 5000 milliseconds",
      );
    },
  );

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
    const init = signedRequest(
      payload,
      "delivery-review-route",
      "pull_request_review",
    );

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

// Opt-in cross-repository proof:
// SHIPWRIGHT_TEST_SYMPHONY_CHECKOUT=/path/to/pinned/symphony \
// SHIPWRIGHT_TEST_PYTHON=/path/to/python-with-aiohttp \
// pnpm exec vitest run server/routes/api/github/webhook.post.spec.ts
describe.skipIf(!symphonyCheckout)(
  "Shipwright to the pinned Symphony signed receiver",
  () => {
    test("is retryable, byte-exact, replay-safe, and conflict-safe end to end", async () => {
      const actualSymphonyCommit = execFileSync(
        "git",
        ["-C", symphonyCheckout, "rev-parse", "HEAD"],
        { encoding: "utf8" },
      ).trim();
      expect(actualSymphonyCommit).toBe(EXPECTED_SYMPHONY_COMMIT);

      const tempDirectory = await mkdtemp(
        join(tmpdir(), "shipwright-wks-779-"),
      );
      const workflowPath = join(tempDirectory, "WORKFLOW.md");
      await writeFile(workflowPath, "---\n---\n", { mode: 0o600 });
      const port = await unusedLoopbackPort();
      const relayUrl = `http://127.0.0.1:${port}/webhooks/github`;
      const service = createService();
      await createEnabledAgent(service, [], "pull_request", "opened");
      const receive = vi.fn((input, loadedConfig) =>
        service.receiveGitHubWebhook(input, loadedConfig),
      );
      const createRelayApp = () =>
        new H3().post(
          "/api/github/webhook",
          createGitHubWebhookRoute({
            loadConfig: () => config,
            loadRelayDestination: () => relayUrl,
            receive,
            relayFetch: fetch,
            relayTimeoutMs: 500,
          }),
        );
      const app = createRelayApp();
      const rawBody = ` {\n  "action": "opened",\n  "repository": { "id": 123, "full_name": "dallascrilley/shipwright" },\n  "installation": { "id": 42 },\n  "number": 7,\n  "pull_request": { "number": 7, "head": { "sha": "${"a".repeat(40)}" }, "base": { "ref": "main", "sha": "${"b".repeat(40)}" }, "draft": false, "labels": [] },\n  "body_marker": "wks-779-raw-body-must-not-persist"\n}\n`;
      const deliveryId = "delivery-real-symphony";
      let harness: { child: ChildProcess; stateDb: string } | undefined;

      try {
        const unavailable = await app.request(
          "/api/github/webhook",
          signedRawRequest(rawBody, deliveryId, "pull_request"),
        );
        expect(unavailable.status).toBe(503);
        expect(unavailable.headers.get("retry-after")).toBe("10");
        expect(service.getSnapshot().queueEntries).toHaveLength(1);

        harness = await startSymphonyHarness({ workflowPath, port });
        const accepted = await app.request(
          "/api/github/webhook",
          signedRawRequest(rawBody, deliveryId, "pull_request"),
        );
        expect(accepted.status).toBe(202);

        const stateAfterPull = (await (
          await fetch(`http://127.0.0.1:${port}/__test__/state`)
        ).json()) as { delivery_count: number; counts: Record<string, number> };
        expect(stateAfterPull).toEqual({
          delivery_count: 1,
          counts: { waiting_checks: 1 },
        });

        const replay = await app.request(
          "/api/github/webhook",
          signedRawRequest(rawBody, deliveryId, "pull_request"),
        );
        expect(replay.status).toBe(202);
        expect(service.getSnapshot().queueEntries).toHaveLength(1);

        const changedBody = rawBody.replace(
          "wks-779-raw-body-must-not-persist",
          "wks-779-changed-payload",
        );
        const localConflict = await app.request(
          "/api/github/webhook",
          signedRawRequest(changedBody, deliveryId, "pull_request"),
        );
        expect(localConflict.status).toBe(409);

        const downstreamConflict = await createRelayApp().request(
          "/api/github/webhook",
          signedRawRequest(changedBody, deliveryId, "pull_request"),
        );
        expect(downstreamConflict.status).toBe(409);

        const receiveCountBeforeCheckSuite = receive.mock.calls.length;
        const checkSuiteBody = JSON.stringify({
          action: "completed",
          repository: {
            id: 123,
            full_name: "dallascrilley/shipwright",
          },
          installation: { id: 42 },
          check_suite: { id: 91, head_sha: "a".repeat(40) },
        });
        const checkSuite = await app.request(
          "/api/github/webhook",
          signedRawRequest(
            checkSuiteBody,
            "delivery-real-check-suite",
            "check_suite",
          ),
        );
        expect(checkSuite.status).toBe(202);
        expect(receive.mock.calls).toHaveLength(receiveCountBeforeCheckSuite);

        const invalidSignature = await app.request("/api/github/webhook", {
          ...signedRawRequest("{}", "delivery-invalid-real", "pull_request"),
          headers: {
            ...requestHeaders(),
            "x-github-event": "pull_request",
            "x-github-delivery": "delivery-invalid-real",
            "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
          },
        });
        expect(invalidSignature.status).toBe(401);

        const finalState = (await (
          await fetch(`http://127.0.0.1:${port}/__test__/state`)
        ).json()) as { delivery_count: number; counts: Record<string, number> };
        expect(finalState).toEqual({
          delivery_count: 2,
          counts: { waiting_checks: 1 },
        });

        await stopSymphonyHarness(harness.child);
        const stateDatabase = await readFile(harness.stateDb);
        harness = undefined;
        expect(
          stateDatabase.includes("wks-779-raw-body-must-not-persist"),
        ).toBe(false);
      } finally {
        if (harness) await stopSymphonyHarness(harness.child);
        await rm(tempDirectory, { recursive: true, force: true });
      }
    });
  },
);
