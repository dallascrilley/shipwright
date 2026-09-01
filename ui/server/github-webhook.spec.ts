import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import type {
  GithubTriggerCondition,
  GithubTriggerEvent,
} from "../shared/agent-definition";
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

const EXPECTED_REVIEWER_LOGIN = "review-app[bot]";
const EXPECTED_INSTALLATION_ID = 42;

type ReviewAuthorizationOverride = {
  expectedReviewerLogin?: string;
  expectedReviewerUserId?: number;
  installationId?: number;
};

function createFixture(
  authorization: ReviewAuthorizationOverride = {
    expectedReviewerLogin: EXPECTED_REVIEWER_LOGIN,
    installationId: EXPECTED_INSTALLATION_ID,
  },
) {
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
    installationId:
      authorization.installationId ?? EXPECTED_INSTALLATION_ID,
    allowedRepositories: new Set(["dallascrilley/shipwright"]),
    allowedOwners: new Set(),
    store,
    dispatcher,
    expectedReviewerLogin: authorization.expectedReviewerLogin,
    expectedReviewerUserId: authorization.expectedReviewerUserId,
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

function createEnabledReviewTrigger(
  conditions: GithubTriggerCondition[] = [],
  authorization?: ReviewAuthorizationOverride,
) {
  const fixture = createFixture(authorization);
  const agent = fixture.controlPlane.createAgent({
    name: "Review intake",
    instructions: "Process App-submitted reviews as a dry run.",
    actionPreset: "resolve_pr_feedback",
    skillId: "fix-review-findings",
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
    config: {
      event: "pull_request_review",
      actions: ["submitted"],
      conditions,
    },
  });
  return { ...fixture, agent, trigger };
}

function signedInput(
  event: GithubTriggerEvent,
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

const reviewPayload = {
  action: "submitted",
  repository: { full_name: "dallascrilley/shipwright" },
  installation: { id: EXPECTED_INSTALLATION_ID },
  sender: { login: EXPECTED_REVIEWER_LOGIN },
  review: {
    id: 101,
    user: { login: EXPECTED_REVIEWER_LOGIN, type: "Bot", id: 555 },
    commit_id: "review-head-sha",
    body: "review-body-marker",
  },
  pull_request: {
    number: 7,
    head: { sha: "review-head-sha" },
    base: { ref: "main" },
    draft: false,
    labels: [],
  },
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

  test("keeps matching triggers on distinct revisions independent for one delivery", async () => {
    const fixture = createEnabledIssueTrigger();
    const updatedAgent = fixture.controlPlane.updateAgent(
      fixture.agent.agentId,
      fixture.agent.currentRevision,
      {
        name: "Issue triage v2",
        instructions: "Triage inbound issues as a dry run with the current rules.",
        actionPreset: "fix_issue",
        skillId: "",
        allowedTools: ["github", "sandbox"],
        targetScope: {
          repository: "dallascrilley/shipwright",
          branch: "main",
        },
        verification: { presetId: "bun-test" },
        publicationPolicy: "dry_run",
      },
    );
    const second = fixture.controlPlane.createTrigger({
      agentId: fixture.agent.agentId,
      expectedRevision: updatedAgent.currentRevision,
      kind: "github",
      config: { event: "issues", actions: ["opened"], conditions: [] },
    });
    const input = await signedInput(
      "issues",
      "delivery-distinct-revisions",
      issuePayload,
    );

    await expect(fixture.ingress.receive(input)).resolves.toMatchObject({
      status: "accepted",
      matched: 2,
    });
    expect(fixture.dispatcher.list()).toHaveLength(2);
    expect(fixture.store.load().executions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentRevision: 1,
          triggerId: fixture.trigger.triggerId,
          idempotencyKey: "github:delivery-distinct-revisions:1",
        }),
        expect.objectContaining({
          agentRevision: 2,
          triggerId: second.triggerId,
          idempotencyKey: "github:delivery-distinct-revisions:2",
        }),
      ]),
    );

    await fixture.ingress.receive(input);
    expect(fixture.dispatcher.list()).toHaveLength(2);
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

  test("queues one App-submitted review only after validating its provenance", async () => {
    const fixture = createEnabledReviewTrigger([
      { field: "actor", operator: "is_one_of", values: ["review-app[bot]"] },
      { field: "base_branch", operator: "is_one_of", values: ["main"] },
      { field: "draft_state", operator: "is_not_draft" },
    ]);
    const input = await signedInput(
      "pull_request_review",
      "delivery-review-1",
      reviewPayload,
    );

    await expect(fixture.ingress.receive(input)).resolves.toMatchObject({
      status: "accepted",
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

    const execution = fixture.store.load().executions[0];
    expect(execution).toMatchObject({
      agentRevision: fixture.trigger.agentRevision,
      source: "github",
      idempotencyKey: "github:delivery-review-1:1",
      target: {
        kind: "pull",
        owner: "dallascrilley",
        repo: "shipwright",
        number: 7,
      },
    });
    expect(fixture.dispatcher.list()).toHaveLength(1);
    expect(JSON.stringify(fixture.store.load())).not.toContain(
      "review-body-marker",
    );

    await expect(fixture.ingress.receive(input)).resolves.toMatchObject({
      status: "accepted",
      matched: 1,
    });
    expect(fixture.dispatcher.list()).toHaveLength(1);
  });

  test("rejects submitted reviews with incomplete or inconsistent provenance before queueing", async () => {
    const invalidPayloads = [
      ["missing installation", { ...reviewPayload, installation: undefined }],
      [
        "malformed installation",
        { ...reviewPayload, installation: { id: "42" } },
      ],
      [
        "human reviewer",
        {
          ...reviewPayload,
          review: {
            ...reviewPayload.review,
            user: { login: "human-reviewer", type: "User" },
          },
        },
      ],
      [
        "missing review id",
        { ...reviewPayload, review: { ...reviewPayload.review, id: 0 } },
      ],
      [
        "reviewed commit mismatch",
        {
          ...reviewPayload,
          review: { ...reviewPayload.review, commit_id: "different-head-sha" },
        },
      ],
      [
        "missing pull request head",
        {
          ...reviewPayload,
          pull_request: { ...reviewPayload.pull_request, head: undefined },
        },
      ],
      [
        "unexpected reviewer login",
        {
          ...reviewPayload,
          sender: { login: "other-app[bot]" },
          review: {
            ...reviewPayload.review,
            user: { login: "other-app[bot]", type: "Bot", id: 555 },
          },
        },
      ],
      [
        "unexpected installation id",
        { ...reviewPayload, installation: { id: 4242 } },
      ],
      ["missing sender", { ...reviewPayload, sender: undefined }],
      [
        "sender mismatched with reviewer",
        { ...reviewPayload, sender: { login: "someone-else[bot]" } },
      ],
      ["non-submitted action", { ...reviewPayload, action: "dismissed" }],
    ] as const;

    for (const [name, payload] of invalidPayloads) {
      const fixture = createEnabledReviewTrigger();
      await expect(
        fixture.ingress.receive(
          await signedInput(
            "pull_request_review",
            `delivery-review-invalid-${name.replace(/\s+/g, "-")}`,
            payload,
          ),
        ),
      ).resolves.toEqual({ status: "rejected", reason: "invalid_payload" });
      expect(fixture.dispatcher.list()).toHaveLength(0);
    }
  });

  test("rejects an otherwise valid submitted review when no reviewer identity is configured", async () => {
    const fixture = createEnabledReviewTrigger([], {
      installationId: EXPECTED_INSTALLATION_ID,
    });

    await expect(
      fixture.ingress.receive(
        await signedInput(
          "pull_request_review",
          "delivery-review-unconfigured",
          reviewPayload,
        ),
      ),
    ).resolves.toEqual({ status: "rejected", reason: "invalid_payload" });
    expect(fixture.dispatcher.list()).toHaveLength(0);
  });

  test("pins the reviewer bot user id when one is configured", async () => {
    const authorization = {
      expectedReviewerLogin: EXPECTED_REVIEWER_LOGIN,
      expectedReviewerUserId: 555,
      installationId: EXPECTED_INSTALLATION_ID,
    };

    const matching = createEnabledReviewTrigger([], authorization);
    await expect(
      matching.ingress.receive(
        await signedInput(
          "pull_request_review",
          "delivery-review-user-id-match",
          reviewPayload,
        ),
      ),
    ).resolves.toMatchObject({ status: "accepted", matched: 1 });

    const impostor = createEnabledReviewTrigger([], authorization);
    await expect(
      impostor.ingress.receive(
        await signedInput("pull_request_review", "delivery-review-user-id-x", {
          ...reviewPayload,
          review: {
            ...reviewPayload.review,
            user: { login: EXPECTED_REVIEWER_LOGIN, type: "Bot", id: 999 },
          },
        }),
      ),
    ).resolves.toEqual({ status: "rejected", reason: "invalid_payload" });
    expect(impostor.dispatcher.list()).toHaveLength(0);
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
