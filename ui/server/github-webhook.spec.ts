import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  AgentControlPlane,
  MemoryAgentControlPlaneStore,
} from "./agent-control-plane";
import { GitHubWebhookIngress } from "./github-webhook";
import { QueueDispatcher } from "./queue-dispatcher";
const WEBHOOK_SECRET = "test-webhook-signing-value";

function signPayload(payload: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex")}`;
}

function createFixture() {
  const now = () => "2026-07-21T00:00:00.000Z";
  const store = new MemoryAgentControlPlaneStore();
  let id = 0;
  const controlPlane = new AgentControlPlane(store, () => `id-${++id}`, now);
  const dispatcher = new QueueDispatcher(store, () => `id-${++id}`, now, {
    leaseDurationMs: 1_000,
    globalConcurrency: 1,
    perAgentConcurrency: 1,
    failureThreshold: 3,
  });
  const ingress = new GitHubWebhookIngress({
    webhookSecret: WEBHOOK_SECRET,
    allowedRepositories: new Set(["dallascrilley/shipwright"]),
    store,
    dispatcher,
  });
  return { controlPlane, dispatcher, ingress, store };
}

function createEnabledIssueTrigger() {
  const fixture = createFixture();
  const agent = fixture.controlPlane.createAgent({
    name: "Issue triage",
    instructions: "Triage inbound issues as a dry run.",
    skillId: "fix-review-findings",
    allowedTools: ["github", "sandbox"],
    targetScope: { repository: "dallascrilley/shipwright", branch: "main" },
    verification: { presetId: "bun-test" },
    publicationPolicy: "dry_run",
  });
  fixture.controlPlane.setEnabled(agent.agentId, agent.currentRevision, true);
  fixture.controlPlane.createTrigger({
    agentId: agent.agentId,
    expectedRevision: agent.currentRevision,
    kind: "github",
    config: { event: "issues", actions: ["opened"] },
  });
  return fixture;
}

function signedInput(
  event: "issues" | "pull_request",
  deliveryId: string,
  payload: object,
) {
  const rawBody = JSON.stringify(payload);
  return {
    event,
    deliveryId,
    rawBody,
    signature: signPayload(rawBody),
  };
}

const issuePayload = {
  action: "opened",
  repository: { full_name: "dallascrilley/shipwright" },
  issue: { number: 42 },
};

describe("GitHubWebhookIngress", () => {
  test("rejects an invalid signature before parsing the payload", async () => {
    const fixture = createFixture();

    await expect(
      fixture.ingress.receive({
        event: "issues",
        deliveryId: "delivery-1",
        rawBody: "not valid JSON",
        signature: "sha256=invalid",
      }),
    ).resolves.toEqual({ status: "rejected", reason: "invalid_signature" });
    expect(fixture.dispatcher.list()).toEqual([]);
  });

  test("rejects a non-ASCII signature of matching code-unit length", async () => {
    const fixture = createFixture();

    await expect(
      fixture.ingress.receive({
        event: "issues",
        deliveryId: "delivery-unicode-signature",
        rawBody: JSON.stringify(issuePayload),
        signature: `${"x".repeat(70)}é`,
      }),
    ).resolves.toEqual({ status: "rejected", reason: "invalid_signature" });
    expect(fixture.dispatcher.list()).toEqual([]);
  });

  test("rejects oversized payloads without queueing work", async () => {
    const fixture = createFixture();

    await expect(
      fixture.ingress.receive({
        event: "issues",
        deliveryId: "delivery-oversized",
        rawBody: "x".repeat(1_048_577),
        signature: "sha256=invalid",
      }),
    ).resolves.toEqual({ status: "rejected", reason: "invalid_payload" });
    expect(fixture.dispatcher.list()).toEqual([]);
  });

  test("queues one matching signed issue delivery and deduplicates its replay", async () => {
    const fixture = createEnabledIssueTrigger();
    const input = await signedInput("issues", "delivery-1", issuePayload);

    await expect(fixture.ingress.receive(input)).resolves.toEqual({
      status: "accepted",
      matched: 1,
    });
    await expect(fixture.ingress.receive(input)).resolves.toEqual({
      status: "accepted",
      matched: 1,
    });
    expect(fixture.dispatcher.list()).toMatchObject([
      {
        state: "queued",
        agentRevision: 1,
        executionId: expect.any(String),
      },
    ]);
    expect(fixture.dispatcher.list()).toHaveLength(1);
  });

  test("ignores disabled agents and unmatched repositories without queueing", async () => {
    const disabled = createFixture();
    const agent = disabled.controlPlane.createAgent({
      name: "Disabled issue triage",
      instructions: "Do not run while disabled.",
      skillId: "fix-review-findings",
      allowedTools: ["github"],
      targetScope: { repository: "dallascrilley/shipwright" },
      verification: { presetId: "bun-test" },
      publicationPolicy: "dry_run",
    });
    disabled.controlPlane.createTrigger({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      kind: "github",
      config: { event: "issues", actions: ["opened"] },
    });

    await expect(
      disabled.ingress.receive(await signedInput("issues", "delivery-2", issuePayload)),
    ).resolves.toEqual({ status: "accepted", matched: 0 });
    await expect(
      disabled.ingress.receive(
        await signedInput("issues", "delivery-3", {
          ...issuePayload,
          repository: { full_name: "dallascrilley/other-repository" },
        }),
      ),
    ).resolves.toEqual({ status: "accepted", matched: 0 });
    expect(disabled.dispatcher.list()).toEqual([]);
  });

  test("queues pull requests and retains no raw payload content", async () => {
    const fixture = createFixture();
    const agent = fixture.controlPlane.createAgent({
      name: "Pull request triage",
      instructions: "Triage pull requests as a dry run.",
      skillId: "fix-review-findings",
      allowedTools: ["github", "sandbox"],
      targetScope: { repository: "dallascrilley/shipwright" },
      verification: { presetId: "bun-test" },
      publicationPolicy: "dry_run",
    });
    fixture.controlPlane.setEnabled(agent.agentId, agent.currentRevision, true);
    fixture.controlPlane.createTrigger({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      kind: "github",
      config: { event: "pull_request", actions: ["opened"] },
    });
    const payload = {
      action: "opened",
      repository: { full_name: "dallascrilley/shipwright" },
      number: 7,
      pull_request: { title: "raw-payload-marker" },
    };

    await fixture.ingress.receive(await signedInput("pull_request", "delivery-4", payload));

    expect(fixture.dispatcher.list()).toMatchObject([
      { executionId: expect.any(String), state: "queued" },
    ]);
    expect(JSON.stringify(fixture.store.load())).not.toContain("raw-payload-marker");
  });
});
