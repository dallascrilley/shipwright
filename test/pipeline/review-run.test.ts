import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import {
  computeReviewChecksDigest,
  readReviewCandidate,
  reviewCandidatePath,
  type ReviewAuthorizedDeliveryPlan,
  type ReviewEffectJournalStore,
  type ReviewEffectReceipt,
  type ReviewFindingVerificationRecord,
} from "../../src/pipeline/repair-candidate.js";
import { parseReviewArgs } from "../../src/cli/review-args.js";
import {
  isProviderQuotaError,
  PROVIDER_QUOTA_ERROR_CODE,
  REVIEW_OUTCOME_MISSING_ERROR_CODE,
  runReviewAgent,
  type ReviewPipelineDependencies,
  type ReviewWorkspacePort,
} from "../../src/pipeline/review-run.js";
import type { AuthorizedPullRequest } from "../../src/github/app-client.js";
const candidateRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    candidateRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function fixture(options: {
  changes?: string[];
  verifyExit?: number;
  integrationVerifyExit?: number;
  movedHead?: boolean;
  outcome?: "fixed" | "rejected" | "needs-human";
  artifactMissing?: boolean;
  agentResponse?: string;
  threadIds?: string[];
} = {}) {
  const events: string[] = [];
  const changes = options.changes ?? ["src/a.ts"];
  const outcome = options.outcome ?? "fixed";
  const threadIds = options.threadIds ?? ["thread-1"];
  let verifyCalls = 0;
  let remoteHead = "head1";
  let currentCommit = "commit1";
  let followUpHead = "";
  let followUpPullRequest: { number: number; url: string; title: string; body: string } | undefined;
  const resolvedThreadIds = new Set<string>();
  let replyBody = "";
  const thread = (id: string) => ({
    id,
    isResolved: resolvedThreadIds.has(id),
    isOutdated: false,
    path: id === "thread-1" ? "src/a.ts" : `src/${id}.ts`,
    line: 4,
    comments: [
      {
        id: id === "thread-1" ? "comment-1" : `comment-${id}`,
        body: id === "thread-1" ? "Please add a guard" : `Please add a guard for ${id}`,
        url: id === "thread-1" ? "https://example/comment" : `https://example/${id}`,
        author: "reviewer",
      },
      ...(replyBody && id === "thread-1"
        ? [{ id: "reply-1", body: replyBody, url: "https://example/reply", author: "bot" }]
        : []),
    ],
  });
  const repositoryClient: AuthorizedPullRequest["repositoryClient"] = {
    async getRepository() { throw new Error("unused"); },
    async getIssue() { throw new Error("unused"); },
    async getBranchSha(branch) {
      events.push("remote-head");
      if (branch === "feature") return options.movedHead ? "moved" : remoteHead;
      return followUpHead;
    },
    async listPullRequests() {
      return followUpPullRequest
        ? [{ ...followUpPullRequest, headSha: followUpHead }]
        : [];
    },
    async createPullRequest(input) {
      events.push("create-follow-up");
      followUpPullRequest = {
        number: 5,
        url: "https://github.com/acme/widget/pull/5",
        title: input.title,
        body: input.body,
      };
      return { number: followUpPullRequest.number, url: followUpPullRequest.url };
    },
    async getPullRequest(number) {
      if (number === 5 && followUpPullRequest) {
        return {
          title: followUpPullRequest.title,
          body: followUpPullRequest.body,
          state: "open",
          draft: false,
          baseBranch: "feature",
          baseSha: "head1",
          headBranch: "shipwright/review-run-1",
          headSha: followUpHead,
          headOwner: "acme",
          headRepo: "widget",
        };
      }
      return {
        title: "Change", body: "body", state: "open", draft: false,
        baseBranch: "main", baseSha: "base1", headBranch: "feature",
        headSha: options.movedHead ? "moved" : remoteHead, headOwner: "acme", headRepo: "widget",
      };
    },
    async listReviewThreads() { events.push("threads"); return threadIds.map(thread); },
    async listReviews() { return []; },
    async replyToReviewThread(_id, body) { events.push("reply"); replyBody = body; return { url: "https://example/reply" }; },
    async resolveReviewThread(id) { events.push("resolve"); resolvedThreadIds.add(id); return { isResolved: true }; },
    async addPullRequestComment() { throw new Error("unused"); },
  };
  const authorized: AuthorizedPullRequest = {
    pullRequest: {
      owner: "acme", repo: "widget", number: 4, url: "https://github.com/acme/widget/pull/4",
      title: "Change", body: "body", draft: false, baseBranch: "main", baseSha: "base1", headBranch: "feature", headSha: "head1", installationId: 1,
    },
    reviewThreads: threadIds.map(thread),
    reviews: [{ id: "review-1", state: "CHANGES_REQUESTED", body: "review", author: "reviewer" }],
    repositoryClient,
    async withInstallationToken(action) { return action("secret"); },
  };
  const workspace: ReviewWorkspacePort = {
    async clonePullRequest() { events.push("clone"); },
    async prepareForAgent() { events.push("prepare"); },
    async prepareReviewArtifact() { events.push("reserve-artifact"); },
    async readAndRemoveArtifact() {
      events.push("artifact");
      if (options.artifactMissing) {
        throw new Error("review outcome artifact failed: cat: .agentos-review-resolution.json: No such file or directory");
      }
      return JSON.stringify({
        threads: threadIds.map((threadId) => ({
          threadId,
          outcome,
          summary: "Handled",
          evidence: "src/a.ts:4",
        })),
      });
    },
    async verify() {
      events.push("verify");
      verifyCalls += 1;
      return {
        exitCode: verifyCalls > 1
          ? options.integrationVerifyExit ?? 0
          : options.verifyExit ?? 0,
      };
    },
    async assertCommitIncluded() { events.push("included"); },
    async assertReviewCandidateIntegrated({ headSha }) {
      events.push(`candidate-integrated:${headSha}`);
      if (headSha !== "head2") throw new Error("fixture candidate was not integrated");
    },
    async inspectChanges(baseSha) {
      events.push("inspect");
      if (baseSha === "head2") {
        return {
          changedFiles: [],
          patch: "",
          patchBytes: 0,
          resultingTreeSha: "tree2",
        };
      }
      return {
        changedFiles: changes,
        patch: changes.length ? "diff" : "",
        patchBytes: changes.length ? 4 : 0,
        resultingTreeSha: "tree1",
      };
    },
    async quiesce() { events.push("quiesce"); },
    async assertRunIdentity() { events.push("identity"); },
    async applyReviewCandidatePatch() { events.push("apply-candidate"); },
    async restoreCommittedReview({ commitSha }) { events.push(`restore:${commitSha}`); return currentCommit; },
    async resetToReviewBase(baseSha, branch) { events.push(`reset:${baseSha}:${branch}`); },
    async commit() { events.push("commit"); return currentCommit; },
    async push(branch) {
      events.push("push");
      if (branch === "feature") remoteHead = currentCommit;
      else followUpHead = currentCommit;
    },
    async destroy() { events.push("destroy"); },
  };
  const receipts: Array<Record<string, unknown>> = [];
  const candidateRoot = join(tmpdir(), `shipwright-review-run-${randomUUID()}`);
  candidateRoots.push(candidateRoot);
  const effects: ReviewEffectReceipt[] = [];
  const records: ReviewFindingVerificationRecord[] = [];
  let storedDeliveryPlan: ReviewAuthorizedDeliveryPlan | undefined;
  const effectJournalFactory = async (): Promise<ReviewEffectJournalStore> => ({
    async load() { return structuredClone(effects); },
    async ensureDeliveryPlan(plan) {
      if (storedDeliveryPlan && JSON.stringify(storedDeliveryPlan) !== JSON.stringify(plan)) {
        throw new Error("fixture delivery plan changed");
      }
      storedDeliveryPlan ??= structuredClone(plan);
      return structuredClone(storedDeliveryPlan);
    },
    async beginEffect(input) {
      const existing = effects.find((effect) => effect.effectId === input.effectId);
      if (existing) return structuredClone(existing);
      const effect: ReviewEffectReceipt = { ...input, status: "intent" };
      effects.push(effect);
      return structuredClone(effect);
    },
    async ackEffect(input) {
      const index = effects.findIndex((effect) => effect.effectId === input.effectId);
      if (index < 0) throw new Error(`unknown effect ${input.effectId}`);
      const effect: ReviewEffectReceipt = {
        ...effects[index]!,
        ...input,
        effectId: effects[index]!.effectId,
        kind: effects[index]!.kind,
        idempotencyKey: effects[index]!.idempotencyKey,
        status: "confirmed",
      };
      effects[index] = effect;
      return structuredClone(effect);
    },
    async markAmbiguous(input) {
      const index = effects.findIndex((effect) => effect.effectId === input.effectId);
      if (index < 0) throw new Error(`unknown effect ${input.effectId}`);
      const effect = { ...effects[index]!, ...input, status: "ambiguous" as const };
      effects[index] = effect;
      return structuredClone(effect);
    },
    async getResumeCursor() { return 0; },
    async setResumeCursor() {},
  });
  const deps: ReviewPipelineDependencies = {
    execution: { runtime: "agentos", software: "pi", provider: "kimi", model: "kimi-for-coding" },
    skill: { name: "fix-review-findings", content: "skill", sha256: "abc123" },
    runId: "run-1",
    async authorize() {
      events.push("authorize");
      if (!options.movedHead) authorized.pullRequest.headSha = remoteHead;
      return authorized;
    },
    async createWorkspace() { events.push("workspace"); return workspace; },
    async runAgent() { events.push("agent"); return options.agentResponse ?? "done"; },
    async writeReceipt(_path, receipt) {
      events.push(`receipt:${receipt.phase}`);
      receipts.push(structuredClone(receipt) as unknown as Record<string, unknown>);
    },
    candidateRoot,
    effectJournalFactory,
    verificationStore: {
      async put(record) { records.push(structuredClone(record)); },
      async lookup(input) {
        return records.find((record) =>
          record.recordId === input.recordId &&
          record.candidateDigest === input.candidateDigest &&
          record.findingId === input.findingId &&
          record.findingDigest === input.findingDigest &&
          record.checksDigest === input.checksDigest,
        );
      },
    },
    findingVerifier: {
      async verify({ candidate, findingId, checks }) {
        const finding = candidate.findings.find((item) => item.findingId === findingId)!;
        return {
          schema: "shipwright-review-verification/v1",
          recordId: `record-${candidate.candidateId}-${findingId}`,
          candidateDigest: candidate.candidateDigest,
          findingId,
          findingDigest: finding.originalContentDigest!,
          checksDigest: computeReviewChecksDigest(checks),
          observedOutcome: outcome,
          observedEvidence: "Host fixture verification",
          observedReproduction: "Host fixture reproduction",
          observedAffectedFiles: [...candidate.changedFiles],
          requiredChecks: checks.requiredChecks,
          riskLevel: "standard",
          independentVerdict: "pass",
          createdAt: "2026-08-20T00:00:00.000Z",
        };
      },
    },
  };
  return {
    deps,
    events,
    receipts,
    getReplyBody: () => replyBody,
    getDeliveryPlan: () => structuredClone(storedDeliveryPlan),
    effects,
    setRemoteHead: (head: string) => { remoteHead = head; },
    setCurrentCommit: (commit: string) => { currentCommit = commit; },
  };
}

const request = {
  pullRequestUrl: "https://github.com/acme/widget/pull/4",
  verifyCommand: "bun test",
  publish: true,
  deliveryMode: "commit" as const,
  ownership: {
    mode: "explicit-handoff" as const,
    ownerId: "shipwright",
    fromOwnerId: "acme",
    handoffId: "handoff-1",
    authorizedBy: "operator",
    source: "operator" as const,
  },
  timeoutMinutes: 2,
};

test("verified changes push before replying and resolving", async () => {
  const { deps, events, getReplyBody } = fixture();
  const receipt = await runReviewAgent(request, deps);
  expect(receipt.commitSha).toBe("commit1");
  expect(events.indexOf("reserve-artifact")).toBeLessThan(events.indexOf("agent"));
  expect(events.indexOf("push")).toBeLessThan(events.indexOf("reply"));
  expect(events.indexOf("quiesce")).toBeLessThan(events.indexOf("commit"));
  expect(events.indexOf("reply")).toBeLessThan(events.indexOf("resolve"));
  expect(getReplyBody()).toContain("Please add a guard");
  expect(getReplyBody()).toContain("agentos-review-run:run-1");
  const result = receipt.threadResults[0]!;
  expect(result.threadId).toBe("thread-1");
  expect(result.resolved).toBe(true);
  expect(result.source).toEqual({
    reviewer: "reviewer",
    commentId: "comment-1",
    commentUrl: "https://example/comment",
    reviewIds: ["review-1"],
  });
  expect(result.fixGroupId).toBe("thread-1");
  expect(result.fixCommitSha).toBe("commit1");
  expect(receipt.lifecycle).toBe("verified");
});
test("direct publication requires explicit ownership before any remote write", async () => {
  const { deps, events } = fixture();
  await expect(runReviewAgent({ ...request, ownership: undefined }, deps)).rejects.toThrow(
    "explicit review ownership authorization",
  );
  expect(events).not.toContain("commit");
  expect(events).not.toContain("push");
  expect(events).not.toContain("reply");
  expect(events).not.toContain("resolve");
});

test("binds publication ownership to host task provenance, not repository namespace", async () => {
  const { deps } = fixture();
  const receipt = await runReviewAgent({
    ...request,
    ownership: {
      mode: "explicit-handoff",
      ownerId: "local-operator",
      fromOwnerId: "local-task-owner",
      handoffId: "handoff-task-owner",
      authorizedBy: "operator",
      source: "operator",
    },
    provenance: { taskId: "WKS-2245", actor: "local-task-owner" },
  }, deps);
  expect(receipt.lifecycle).toBe("verified");
});

test("uses host-authored handoff owner instead of GitHub repository owner", async () => {
  const { deps } = fixture();
  const receipt = await runReviewAgent({
    ...request,
    ownership: {
      ...request.ownership,
      ownerId: "local-operator",
      fromOwnerId: "local-task-owner",
    },
  }, deps);
  expect(receipt.lifecycle).toBe("verified");
});

test("defaults independent findings to separate groups and refuses one combined delivery", async () => {
  const { deps, events, receipts } = fixture({
    threadIds: ["thread-1", "thread-2"],
  });
  await expect(runReviewAgent(request, deps)).rejects.toThrow(
    "independent review fix groups require separately scoped candidates",
  );
  expect(events).not.toContain("commit");
  expect(events).not.toContain("push");
  expect(events).not.toContain("reply");
  expect(events).not.toContain("resolve");
  const failed = receipts.at(-1) as {
    threadResults?: Array<{ fixGroupId?: string }>;
  };
  expect(failed.threadResults?.map((result) => result.fixGroupId)).toEqual([
    "thread-1",
    "thread-2",
  ]);
});


test("post-integration verification gates review closure", async () => {
  const { deps, events, receipts } = fixture({ integrationVerifyExit: 1 });
  await expect(runReviewAgent(request, deps)).rejects.toThrow(
    "post-integration verification failed",
  );
  expect(events).toContain("included");
  expect(events).toContain("push");
  expect(events).not.toContain("reply");
  expect(events).not.toContain("resolve");
  const failed = receipts.at(-1)!;
  expect(failed.lifecycle).toBe("integrated");
  expect(failed.errorMessage).toBe("post-integration verification failed");
  const integration = failed.integrationVerification as {
    baseSha?: string;
    headSha?: string;
    passed?: boolean;
  };
  expect(integration.baseSha).toBe("head1");
  expect(integration.headSha).toBe("commit1");
  expect(integration.passed).toBe(false);
});

test("head movement during integration verification prevents stale thread writes", async () => {
  const fixtureValue = fixture();
  const workspace = await fixtureValue.deps.createWorkspace();
  const verify = workspace.verify.bind(workspace);
  let calls = 0;
  workspace.verify = async (...args) => {
    const result = await verify(...args);
    if (++calls === 2) fixtureValue.setRemoteHead("newer-owner-head");
    return result;
  };
  await expect(runReviewAgent(request, fixtureValue.deps)).rejects.toThrow("head moved");
  expect(fixtureValue.events).not.toContain("reply");
  expect(fixtureValue.events).not.toContain("resolve");
});
test("recreates a confirmed commit when the unpushed workspace was destroyed", async () => {
  const fixtureValue = fixture();
  const firstReceipt = await runReviewAgent(request, fixtureValue.deps);
  const pushIndex = fixtureValue.effects.findIndex((effect) => effect.kind === "push");
  fixtureValue.effects.splice(pushIndex, 1);
  fixtureValue.setRemoteHead("head1");
  fixtureValue.setCurrentCommit("commit2");
  fixtureValue.deps.candidateLoader = {
    async load(candidateId) {
      return readReviewCandidate(
        reviewCandidatePath(fixtureValue.deps.candidateRoot!, candidateId),
      );
    },
  };

  const resumedReceipt = await runReviewAgent({
    ...request,
    candidateId: firstReceipt.candidateId,
  }, fixtureValue.deps);

  expect(fixtureValue.events).toContain("restore:commit1");
  expect(resumedReceipt.commitSha).toBe("commit2");
  expect(fixtureValue.effects.find((effect) => effect.kind === "commit")?.commitSha).toBe("commit2");
});
test("replays an already integrated direct publication without moving the original head", async () => {
  const fixtureValue = fixture();
  const firstReceipt = await runReviewAgent(request, fixtureValue.deps);
  fixtureValue.deps.candidateLoader = {
    async load(candidateId) {
      return readReviewCandidate(
        reviewCandidatePath(fixtureValue.deps.candidateRoot!, candidateId),
      );
    },
  };

  const resumedReceipt = await runReviewAgent({
    ...request,
    candidateId: firstReceipt.candidateId,
  }, fixtureValue.deps);

  expect(resumedReceipt.lifecycle).toBe("verified");
  expect(resumedReceipt.commitSha).toBe("commit1");
  expect(fixtureValue.events.filter((event) => event === "commit")).toHaveLength(1);
  expect(fixtureValue.events.filter((event) => event === "push")).toHaveLength(1);
  expect(fixtureValue.events.filter((event) => event === "included")).toHaveLength(2);
});


test("publish CLI defaults to a guarded follow-up PR", async () => {
  const args = parseReviewArgs([
    request.pullRequestUrl,
    "--verify", request.verifyCommand,
    "--skill", "/skills/fix-review-findings/SKILL.md",
    "--publish",
    "--owner-id", "acme",
  ]);
  const { deps, events } = fixture();
  const receipt = await runReviewAgent(args, deps);
  expect(args.deliveryMode).toBeUndefined();
  expect(args.ownership).toEqual({
    mode: "local-owner",
    ownerId: "acme",
    source: "operator",
  });
  expect(receipt.deliveryMode).toBe("follow-up-pr");
  expect(receipt.followUpPullRequestUrl).toBe("https://github.com/acme/widget/pull/5");
  expect(events).toContain("push");
  expect(events).not.toContain("reply");
});

test("valid no-code rejection replies without committing", async () => {
  const { deps, events } = fixture({ changes: [], outcome: "rejected" });
  const receipt = await runReviewAgent(request, deps);
  expect(receipt.commitSha).toBeUndefined();
  expect(events).not.toContain("commit");
  expect(events).not.toContain("push");
  expect(events.indexOf("quiesce")).toBeLessThan(events.indexOf("reply"));
  expect(events).toContain("reply");
  expect(events).toContain("resolve");
});

test("needs-human replies and remains unresolved", async () => {
  const { deps, events } = fixture({ changes: [], outcome: "needs-human" });
  const receipt = await runReviewAgent(request, deps);
  expect(events).not.toContain("resolve");
  expect(receipt.remainingOpenThreadIds).toEqual(["thread-1"]);
});

test("verification failure blocks all remote writes", async () => {
  const { deps, events, receipts } = fixture({ verifyExit: 1 });
  await expect(runReviewAgent(request, deps)).rejects.toThrow("verification failed");
  expect(events).not.toContain("commit");
  expect(events).not.toContain("push");
  expect(events).not.toContain("reply");
  expect(events).not.toContain("resolve");
  expect(events.at(-1)).toBe("destroy");
  const failed = receipts.at(-1) as { errorCode?: string; errorMessage?: string };
  expect(failed.errorCode).toBe("verify_failed");
  expect(failed.errorMessage).toBe("independent verification failed");
});

test("remote head movement blocks commit, push, and thread writes", async () => {
  const { deps, events } = fixture({ movedHead: true });
  await expect(runReviewAgent(request, deps)).rejects.toThrow("head moved");
  expect(events).not.toContain("commit");
  expect(events).not.toContain("push");
  expect(events).not.toContain("reply");
});

test("dry run verifies but performs no remote writes", async () => {
  const { deps, events } = fixture();
  const receipt = await runReviewAgent({ ...request, publish: false }, deps);
  expect(receipt.phase).toBe("complete");
  expect(events).not.toContain("commit");
  expect(events).not.toContain("push");
  expect(events).not.toContain("reply");
});
test("binds an owner when publishing an unattributed retained candidate", async () => {
  const fixtureValue = fixture();
  const firstReceipt = await runReviewAgent({
    ...request,
    publish: false,
    deliveryMode: "patch",
    ownership: undefined,
  }, fixtureValue.deps);
  fixtureValue.deps.candidateLoader = {
    async load(candidateId) {
      return readReviewCandidate(
        reviewCandidatePath(fixtureValue.deps.candidateRoot!, candidateId),
      );
    },
  };
  const resumedArgs = parseReviewArgs([
    request.pullRequestUrl,
    "--verify", request.verifyCommand,
    "--skill", "/skills/fix-review-findings/SKILL.md",
    "--publish",
    "--delivery-mode", "follow-up-pr",
    "--owner-id", "acme",
    "--candidate-id", firstReceipt.candidateId!,
  ]);
  const resumedReceipt = await runReviewAgent(resumedArgs, fixtureValue.deps);
  expect(resumedReceipt.lifecycle).toBe("delivered");
  expect(resumedReceipt.followUpPullRequestUrl).toBe("https://github.com/acme/widget/pull/5");
});

test("missing outcome artifact surfaces the agent response and redacts secrets", async () => {
  const { deps, events, receipts } = fixture({
    artifactMissing: true,
    agentResponse: "Could not authenticate to provider. token=ghp_abcdefghijklmnopqrstuvwxyz012345",
  });
  deps.execution.attempts = [
    { provider: "kimi", model: "kimi-for-coding", outcome: "succeeded" },
  ];
  await expect(runReviewAgent(request, deps)).rejects.toThrow(
    "review agent finished without writing .agentos-review-resolution.json",
  );
  expect(events).not.toContain("verify");
  expect(events).not.toContain("commit");
  expect(events).not.toContain("push");
  expect(events).not.toContain("reply");
  expect(events.at(-1)).toBe("destroy");
  const failed = receipts.at(-1) as { errorCode?: string; errorMessage?: string };
  expect(failed.errorCode).toBe(REVIEW_OUTCOME_MISSING_ERROR_CODE);
  expect(failed.errorMessage).toContain("Could not authenticate to provider");
  expect(failed.errorMessage).toContain("[REDACTED]");
  expect(failed.errorMessage).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
  expect(deps.execution.attempts[0]?.outcome).toBe("failed");
});

test("quota-exhausted provider failure is classified distinctly", async () => {
  const { deps, events, receipts } = fixture({
    artifactMissing: true,
    agentResponse:
      '403 {"error":{"type":"permission_error","message":"You\'ve reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan."}}',
  });
  await expect(runReviewAgent(request, deps)).rejects.toThrow(
    "review agent finished without writing",
  );
  expect(events).not.toContain("verify");
  const failed = receipts.at(-1) as { phase?: string; errorCode?: string; errorMessage?: string };
  expect(failed.phase).toBe("agent");
  expect(failed.errorCode).toBe(PROVIDER_QUOTA_ERROR_CODE);
  expect(failed.errorMessage).toContain("usage limit");
});

test("isProviderQuotaError matches quota exhaustion but not agent or verify failures", () => {
  expect(isProviderQuotaError("You've reached your usage limit for this billing cycle")).toBe(true);
  expect(isProviderQuotaError("Your quota will be refreshed in the next cycle")).toBe(true);
  expect(isProviderQuotaError("purchase extra usage or upgrade your plan")).toBe(true);
  expect(isProviderQuotaError("insufficient credit balance")).toBe(true);
  expect(isProviderQuotaError("Could not authenticate to provider")).toBe(false);
  expect(isProviderQuotaError("independent verification failed")).toBe(false);
  expect(isProviderQuotaError("")).toBe(false);
});

test("an agent change to a verification-protected path cannot publish", async () => {
  const { deps, events, receipts } = fixture({ changes: ["seed/average.js", "seed/verify.js"] });
  await expect(
    runReviewAgent({ ...request, protectedPaths: ["seed/verify.js"] }, deps),
  ).rejects.toThrow("verification-protected path changed: seed/verify.js");
  // The sandbox is quiesced (killing any verify-forked writer) before the
  // protected-path gate, so verify runs but no remote write happens.
  expect(events).toContain("verify");
  expect(events.indexOf("quiesce")).toBeLessThan(events.indexOf("inspect"));
  expect(events).not.toContain("commit");
  expect(events).not.toContain("push");
  expect(events).not.toContain("reply");
  expect(events).not.toContain("resolve");
  expect(events.at(-1)).toBe("destroy");
  const failed = receipts.at(-1) as { phase?: string };
  expect(failed.phase).toBe("policy");
});

test("protected paths leave an untouched-gate repair unaffected", async () => {
  const { deps, events } = fixture();
  const receipt = await runReviewAgent(
    { ...request, protectedPaths: ["seed/verify.js"] },
    deps,
  );
  expect(receipt.commitSha).toBe("commit1");
  expect(events).toContain("verify");
});

test("follow-up CLI requests derive and replay the retained candidate base", async () => {
  const { deps, events, getDeliveryPlan } = fixture();
  const cliArgs = parseReviewArgs([
    request.pullRequestUrl,
    "--verify", request.verifyCommand,
    "--skill", "/tmp/fix-review-findings/SKILL.md",
    "--publish",
    "--delivery-mode", "follow-up-pr",
    "--owner-id", "acme",
  ]);
  expect("followUpBaseSha" in cliArgs).toBe(false);

  const firstReceipt = await runReviewAgent(cliArgs, deps);
  expect(firstReceipt.followUpPullRequestUrl).toBe("https://github.com/acme/widget/pull/5");
  expect(firstReceipt.candidateId).toBe("run-1");
  expect(firstReceipt.lifecycle).toBe("delivered");
  expect(firstReceipt.threadResults).toEqual([
    expect.objectContaining({ threadId: "thread-1", resolved: false, fixCommitSha: expect.any(String) }),
  ]);

  deps.candidateLoader = {
    async load(candidateId) {
      return readReviewCandidate(reviewCandidatePath(deps.candidateRoot!, candidateId));
    },
  };
  const resumedArgs = parseReviewArgs([
    request.pullRequestUrl,
    "--verify", request.verifyCommand,
    "--skill", "/tmp/fix-review-findings/SKILL.md",
    "--publish",
    "--delivery-mode", "follow-up-pr",
    "--owner-id", "acme",
    "--candidate-id", firstReceipt.candidateId!,
  ]);
  const resumedReceipt = await runReviewAgent(resumedArgs, deps);

  expect(resumedReceipt.followUpPullRequestUrl).toBe(firstReceipt.followUpPullRequestUrl);
  expect(getDeliveryPlan()).toEqual(expect.objectContaining({
    deliveryMode: "follow-up-pr",
    followUpBaseBranch: "feature",
    followUpBaseSha: "head1",
    ownership: expect.objectContaining({ mode: "local-owner", ownerId: "acme" }),
  }));
  expect(events.filter((event) => event === "create-follow-up")).toHaveLength(1);
  expect(events.filter((event) => event === "commit")).toHaveLength(1);
  expect(events.filter((event) => event === "push")).toHaveLength(1);
  expect(events).toContain("reset:head1:shipwright/review-run-1");
});

test("recognizes a squashed or modified owner integration before closing findings", async () => {
  const fixtureValue = fixture();
  const cliArgs = parseReviewArgs([
    request.pullRequestUrl,
    "--verify", request.verifyCommand,
    "--skill", "/tmp/fix-review-findings/SKILL.md",
    "--publish",
    "--delivery-mode", "follow-up-pr",
    "--owner-id", "acme",
  ]);
  const firstReceipt = await runReviewAgent(cliArgs, fixtureValue.deps);
  fixtureValue.setRemoteHead("head2");
  fixtureValue.deps.candidateLoader = {
    async load(candidateId) {
      return readReviewCandidate(
        reviewCandidatePath(fixtureValue.deps.candidateRoot!, candidateId),
      );
    },
  };

  const resumedReceipt = await runReviewAgent({
    ...cliArgs,
    candidateId: firstReceipt.candidateId,
  }, fixtureValue.deps);

  expect(resumedReceipt.lifecycle).toBe("verified");
  expect(resumedReceipt.resultingHeadSha).toBe("head2");
  expect(resumedReceipt.integrationVerification).toEqual(expect.objectContaining({
    headSha: "head2",
    passed: true,
  }));
  expect(fixtureValue.events).toContain("candidate-integrated:head2");
  expect(fixtureValue.events.filter((event) => event === "commit")).toHaveLength(1);
  expect(fixtureValue.events.filter((event) => event === "push")).toHaveLength(1);
  expect(fixtureValue.events.filter((event) => event === "reply")).toHaveLength(1);
  expect(fixtureValue.events.filter((event) => event === "resolve")).toHaveLength(1);
});

test("conflicting explicit follow-up base is rejected before publication", async () => {
  const { deps, events } = fixture();
  await expect(runReviewAgent({
    ...request,
    deliveryMode: "follow-up-pr",
    followUpBaseSha: "f".repeat(40),
  }, deps)).rejects.toThrow("follow-up patch base does not match the selected follow-up base SHA");
  expect(events).not.toContain("reset:head1:shipwright/review-run-1");
  expect(events).not.toContain("create-follow-up");
  expect(events).not.toContain("commit");
  expect(events).not.toContain("push");
});
