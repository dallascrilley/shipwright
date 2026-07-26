import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import type { GithubTriggerCondition } from "../shared/agent-definition";
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
    allowedOwners: new Set(),
    store,
    dispatcher,
  });
  return { controlPlane, dispatcher, ingress, store };
}

function createEnabledIssueTrigger(conditions: GithubTriggerCondition[] = []) {
  const fixture = createFixture();
  const agent = fixture.controlPlane.createAgent({
    name: "Issue triage",
    instructions: "Triage inbound issues as a dry run.",
    actionPreset: "fix_issue",
    skillId: "",
    allowedTools: ["github", "sandbox"],
    targetScope: { repository: "dallascrilley/shipwright", branch: "main" },
    verification: { presetId: "bun-test" },
    publicationPolicy: "dry_run",
  });
  fixture.controlPlane.setEnabled(agent.agentId, agent.currentRevision, true);
  const trigger = fixture.controlPlane.createTrigger({
    agentId: agent.agentId,
    expectedRevision: agent.currentRevision,
    kind: "github",
    config: { event: "issues", actions: ["opened"], conditions },
  });
  return { ...fixture, agent, trigger };
}

function signedInput(
  event:
    | "issues"
    | "pull_request"
    | "pull_request_review_comment"
    | "pull_request_review",
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
  sender: { login: "Alice" },
  issue: { number: 42, labels: [{ name: "bug" }, { name: "urgent" }] },
};

function accepted(matched: number) {
  return {
    status: "accepted" as const,
    matched,
    conditionFiltered: 0,
    decisions: [],
    decisionsTruncated: 0,
  };
}

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

    await expect(fixture.ingress.receive(input)).resolves.toMatchObject({
      ...accepted(1),
      decisions: [
        {
          triggerId: fixture.trigger.triggerId,
          decision: "matched",
          reasonCodes: [],
        },
      ],
    });
    await expect(fixture.ingress.receive(input)).resolves.toMatchObject({
      ...accepted(1),
      decisions: [
        {
          triggerId: fixture.trigger.triggerId,
          decision: "matched",
          reasonCodes: [],
        },
      ],
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
      actionPreset: "fix_issue",
      skillId: "",
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
      disabled.ingress.receive(
        await signedInput("issues", "delivery-2", issuePayload),
      ),
    ).resolves.toEqual(accepted(0));
    await expect(
      disabled.ingress.receive(
        await signedInput("issues", "delivery-3", {
          ...issuePayload,
          repository: { full_name: "dallascrilley/other-repository" },
        }),
      ),
    ).resolves.toEqual(accepted(0));
    expect(disabled.dispatcher.list()).toEqual([]);
  });

  test("queues pull requests and retains no raw payload content", async () => {
    const fixture = createFixture();
    const agent = fixture.controlPlane.createAgent({
      name: "Pull request triage",
      instructions: "Triage pull requests as a dry run.",
      actionPreset: "resolve_pr_feedback",
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

    await fixture.ingress.receive(
      await signedInput("pull_request", "delivery-4", payload),
    );

    expect(fixture.dispatcher.list()).toMatchObject([
      { executionId: expect.any(String), state: "queued" },
    ]);
    expect(JSON.stringify(fixture.store.load())).not.toContain(
      "raw-payload-marker",
    );
  });

  test("extracts pull request base branch and draft state after signature verification", async () => {
    const fixture = createFixture();
    const agent = fixture.controlPlane.createAgent({
      name: "Ready pull requests",
      instructions: "Triage ready pull requests targeting main.",
      actionPreset: "resolve_pr_feedback",
      skillId: "fix-review-findings",
      allowedTools: ["github"],
      targetScope: { repository: "dallascrilley/shipwright" },
      verification: { presetId: "bun-test" },
      publicationPolicy: "dry_run",
    });
    fixture.controlPlane.setEnabled(agent.agentId, agent.currentRevision, true);
    const trigger = fixture.controlPlane.createTrigger({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      kind: "github",
      config: {
        event: "pull_request",
        actions: ["opened"],
        conditions: [
          {
            field: "base_branch",
            operator: "is_one_of",
            values: ["main"],
          },
          { field: "draft_state", operator: "is_not_draft" },
        ],
      },
    });
    const payload = {
      action: "opened",
      repository: issuePayload.repository,
      sender: { login: "Alice" },
      number: 7,
      pull_request: {
        number: 7,
        base: { ref: "main" },
        draft: false,
        labels: [],
      },
    };

    await expect(
      fixture.ingress.receive(
        await signedInput("pull_request", "delivery-pr-condition", payload),
      ),
    ).resolves.toMatchObject({
      matched: 1,
      conditionFiltered: 0,
      decisions: [
        {
          triggerId: trigger.triggerId,
          decision: "matched",
          reasonCodes: [],
        },
      ],
    });

    await expect(
      fixture.ingress.receive(
        await signedInput("pull_request", "delivery-pr-malformed", {
          ...payload,
          pull_request: { ...payload.pull_request, base: { ref: 42 } },
        }),
      ),
    ).resolves.toMatchObject({
      matched: 0,
      conditionFiltered: 1,
      decisions: [
        {
          triggerId: trigger.triggerId,
          decision: "filtered",
          reasonCodes: ["base_branch_malformed"],
        },
      ],
    });
  });

  test("matches typed actor and label conditions and fails closed on mismatch or missing data", async () => {
    const fixture = createEnabledIssueTrigger([
      { field: "actor", operator: "is_one_of", values: ["alice"] },
      { field: "labels", operator: "include_all", values: ["BUG", "urgent"] },
    ]);

    await expect(
      fixture.ingress.receive(
        await signedInput("issues", "delivery-conditions-match", issuePayload),
      ),
    ).resolves.toMatchObject({
      matched: 1,
      conditionFiltered: 0,
      decisions: [
        {
          triggerId: fixture.trigger.triggerId,
          decision: "matched",
          reasonCodes: [],
        },
      ],
    });

    await expect(
      fixture.ingress.receive(
        await signedInput("issues", "delivery-conditions-mismatch", {
          ...issuePayload,
          issue: { number: 42, labels: [{ name: "bug" }] },
        }),
      ),
    ).resolves.toMatchObject({
      matched: 0,
      conditionFiltered: 1,
      decisions: [
        {
          triggerId: fixture.trigger.triggerId,
          decision: "filtered",
          reasonCodes: ["labels_mismatch"],
        },
      ],
    });

    await expect(
      fixture.ingress.receive(
        await signedInput("issues", "delivery-conditions-missing", {
          action: "opened",
          repository: issuePayload.repository,
          issue: issuePayload.issue,
        }),
      ),
    ).resolves.toMatchObject({
      matched: 0,
      conditionFiltered: 1,
      decisions: [
        {
          triggerId: fixture.trigger.triggerId,
          decision: "filtered",
          reasonCodes: ["actor_missing"],
        },
      ],
    });
    expect(fixture.dispatcher.list()).toHaveLength(1);
  });

  test("dispatches once when multiple trigger alternatives match the same revision", async () => {
    const fixture = createEnabledIssueTrigger([
      { field: "actor", operator: "is_one_of", values: ["alice"] },
    ]);
    const second = fixture.controlPlane.createTrigger({
      agentId: fixture.agent.agentId,
      expectedRevision: fixture.agent.currentRevision,
      kind: "github",
      config: {
        event: "issues",
        actions: ["opened"],
        conditions: [
          { field: "labels", operator: "include_any", values: ["bug"] },
        ],
      },
    });
    const input = await signedInput(
      "issues",
      "delivery-overlapping-alternatives",
      issuePayload,
    );

    const result = await fixture.ingress.receive(input);

    expect(result).toMatchObject({
      status: "accepted",
      matched: 1,
      conditionFiltered: 0,
      decisionsTruncated: 0,
    });
    if (result.status !== "accepted") throw new Error("expected acceptance");
    expect(result.decisions).toHaveLength(2);
    expect(
      result.decisions.map((decision) => decision.triggerId).sort(),
    ).toEqual([fixture.trigger.triggerId, second.triggerId].sort());
    expect(
      result.decisions.every((decision) => decision.decision === "matched"),
    ).toBe(true);
    expect(fixture.dispatcher.list()).toHaveLength(1);
    expect(fixture.store.load().executions[0]?.triggerId).toBe(
      [fixture.trigger.triggerId, second.triggerId].sort()[0],
    );

    await fixture.ingress.receive(input);
    expect(fixture.dispatcher.list()).toHaveLength(1);
  });

  test("queues review comment and review submitted pulls with nested PR numbers", async () => {
    const fixture = createFixture();
    const agent = fixture.controlPlane.createAgent({
      name: "Review feedback",
      instructions: "Resolve inbound review feedback as a dry run.",
      skillId: "fix-review-findings",
      allowedTools: ["github", "sandbox"],
      targetScope: { repository: "dallascrilley/shipwright" },
      verification: { presetId: "bun-test" },
      publicationPolicy: "dry_run",
    });
    fixture.controlPlane.setEnabled(agent.agentId, agent.currentRevision, true);
    const commentTrigger = fixture.controlPlane.createTrigger({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      kind: "github",
      config: {
        event: "pull_request_review_comment",
        actions: ["created"],
      },
    });
    const reviewTrigger = fixture.controlPlane.createTrigger({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      kind: "github",
      config: {
        event: "pull_request_review",
        actions: ["submitted"],
      },
    });
    const pullRequest = {
      number: 19,
      base: { ref: "main" },
      draft: false,
      labels: [{ name: "review" }],
    };

    await expect(
      fixture.ingress.receive(
        await signedInput(
          "pull_request_review_comment",
          "delivery-review-comment",
          {
            action: "created",
            repository: { full_name: "dallascrilley/shipwright" },
            sender: { login: "reviewer" },
            pull_request: pullRequest,
            comment: { id: 99, body: "raw-review-comment-marker" },
          },
        ),
      ),
    ).resolves.toMatchObject({
      matched: 1,
      decisions: [
        {
          triggerId: commentTrigger.triggerId,
          decision: "matched",
          reasonCodes: [],
        },
      ],
    });
    await expect(
      fixture.ingress.receive(
        await signedInput("pull_request_review", "delivery-review-submitted", {
          action: "submitted",
          repository: { full_name: "dallascrilley/shipwright" },
          sender: { login: "reviewer" },
          pull_request: pullRequest,
          review: { id: 11, body: "raw-review-body-marker" },
        }),
      ),
    ).resolves.toMatchObject({
      matched: 1,
      decisions: [
        {
          triggerId: reviewTrigger.triggerId,
          decision: "matched",
          reasonCodes: [],
        },
      ],
    });

    expect(fixture.dispatcher.list()).toHaveLength(1);
    expect(fixture.store.load().executions).toMatchObject([
      {
        target: {
          kind: "pull",
          owner: "dallascrilley",
          repo: "shipwright",
          number: 19,
        },
        idempotencyKey: `github:delivery-review-comment:${agent.currentRevision}`,
      },
    ]);
    expect(JSON.stringify(fixture.store.load())).not.toContain(
      "raw-review-comment-marker",
    );
    expect(JSON.stringify(fixture.store.load())).not.toContain(
      "raw-review-body-marker",
    );
  });

  test("coalesces concurrent review-comment deliveries for the same PR", async () => {
    const fixture = createFixture();
    const agent = fixture.controlPlane.createAgent({
      name: "Review coalesce",
      instructions: "Collapse review comment bursts.",
      skillId: "fix-review-findings",
      allowedTools: ["github"],
      targetScope: { repository: "dallascrilley/shipwright" },
      verification: { presetId: "bun-test" },
      publicationPolicy: "dry_run",
    });
    fixture.controlPlane.setEnabled(agent.agentId, agent.currentRevision, true);
    fixture.controlPlane.createTrigger({
      agentId: agent.agentId,
      expectedRevision: agent.currentRevision,
      kind: "github",
      config: {
        event: "pull_request_review_comment",
        actions: ["created"],
      },
    });
    const pullRequest = {
      number: 21,
      base: { ref: "main" },
      draft: false,
      labels: [],
    };

    await fixture.ingress.receive(
      await signedInput("pull_request_review_comment", "delivery-comment-a", {
        action: "created",
        repository: { full_name: "dallascrilley/shipwright" },
        pull_request: pullRequest,
      }),
    );
    await fixture.ingress.receive(
      await signedInput("pull_request_review_comment", "delivery-comment-b", {
        action: "created",
        repository: { full_name: "dallascrilley/shipwright" },
        pull_request: pullRequest,
      }),
    );

    expect(fixture.dispatcher.list()).toHaveLength(1);
    expect(fixture.store.load().executions).toHaveLength(1);
    expect(fixture.store.load().executions[0]?.idempotencyKey).toBe(
      `github:delivery-comment-a:${agent.currentRevision}`,
    );
  });

  test("rejects unsupported GitHub events before queueing", async () => {
    const fixture = createEnabledIssueTrigger();

    await expect(
      fixture.ingress.receive({
        event: "pull_request_review_thread",
        deliveryId: "delivery-unsupported-event",
        rawBody: JSON.stringify(issuePayload),
        signature: signPayload(JSON.stringify(issuePayload)),
      }),
    ).resolves.toEqual({ status: "rejected", reason: "invalid_payload" });
    expect(fixture.dispatcher.list()).toEqual([]);
  });

  test("caps decision evidence without limiting trigger evaluation", async () => {
    const fixture = createEnabledIssueTrigger();
    for (let index = 0; index < 21; index += 1) {
      fixture.controlPlane.createTrigger({
        agentId: fixture.agent.agentId,
        expectedRevision: fixture.agent.currentRevision,
        kind: "github",
        config: { event: "issues", actions: ["opened"], conditions: [] },
      });
    }

    const result = await fixture.ingress.receive(
      await signedInput("issues", "delivery-capped-decisions", issuePayload),
    );

    expect(result).toMatchObject({
      status: "accepted",
      matched: 1,
      conditionFiltered: 0,
      decisionsTruncated: 2,
    });
    if (result.status !== "accepted") throw new Error("expected acceptance");
    expect(result.decisions).toHaveLength(20);
    expect(fixture.dispatcher.list()).toHaveLength(1);
  });
});
