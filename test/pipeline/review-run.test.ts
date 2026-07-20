import { expect, test } from "bun:test";
import { runReviewAgent, type ReviewPipelineDependencies, type ReviewWorkspacePort } from "../../src/pipeline/review-run.js";
import type { AuthorizedPullRequest } from "../../src/github/app-client.js";

function fixture(options: {
  changes?: string[];
  verifyExit?: number;
  movedHead?: boolean;
  outcome?: "fixed" | "rejected" | "needs-human";
} = {}) {
  const events: string[] = [];
  const changes = options.changes ?? ["src/a.ts"];
  const outcome = options.outcome ?? "fixed";
  let remoteHead = "head1";
  let resolved = false;
  let replyBody = "";
  const thread = () => ({
    id: "thread-1",
    isResolved: resolved,
    isOutdated: false,
    path: "src/a.ts",
    line: 4,
    comments: replyBody ? [{ id: "reply-1", body: replyBody, url: "https://example/reply", author: "bot" }] : [{ id: "comment-1", body: "Please add a guard", url: "https://example/comment", author: "reviewer" }],
  });
  const repositoryClient: AuthorizedPullRequest["repositoryClient"] = {
    async getRepository() { throw new Error("unused"); },
    async getIssue() { throw new Error("unused"); },
    async getBranchSha() { events.push("remote-head"); return options.movedHead ? "moved" : remoteHead; },
    async listPullRequests() { return []; },
    async createPullRequest() { throw new Error("unused"); },
    async getPullRequest() {
      return {
        title: "Change", body: "body", state: "open", draft: false,
        baseBranch: "main", baseSha: "base1", headBranch: "feature",
        headSha: options.movedHead ? "moved" : "head1", headOwner: "acme", headRepo: "widget",
      };
    },
    async listReviewThreads() { events.push("threads"); return [thread()]; },
    async listReviews() { return []; },
    async replyToReviewThread(_id, body) { events.push("reply"); replyBody = body; return { url: "https://example/reply" }; },
    async resolveReviewThread() { events.push("resolve"); resolved = true; return { isResolved: true }; },
    async addPullRequestComment() { throw new Error("unused"); },
  };
  const authorized: AuthorizedPullRequest = {
    pullRequest: {
      owner: "acme", repo: "widget", number: 4, url: "https://github.com/acme/widget/pull/4",
      title: "Change", body: "body", baseBranch: "main", baseSha: "base1", headBranch: "feature", headSha: "head1", installationId: 1,
    },
    reviewThreads: [thread()],
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
      return JSON.stringify({ threads: [{ threadId: "thread-1", outcome, summary: "Handled", evidence: "src/a.ts:4" }] });
    },
    async verify() { events.push("verify"); return { exitCode: options.verifyExit ?? 0 }; },
    async inspectChanges() { events.push("inspect"); return { changedFiles: changes, patch: changes.length ? "diff" : "", patchBytes: changes.length ? 4 : 0 }; },
    async quiesce() { events.push("quiesce"); },
    async assertRunIdentity() { events.push("identity"); },
    async commit() { events.push("commit"); remoteHead = "commit1"; return "commit1"; },
    async push() { events.push("push"); },
    async destroy() { events.push("destroy"); },
  };
  const receipts: Array<Record<string, unknown>> = [];
  const deps: ReviewPipelineDependencies = {
    execution: { runtime: "agentos", software: "pi", provider: "kimi", model: "kimi-for-coding" },
    skill: { name: "fix-review-findings", content: "skill", sha256: "abc123" },
    runId: "run-1",
    async authorize() { events.push("authorize"); return authorized; },
    async createWorkspace() { events.push("workspace"); return workspace; },
    async runAgent() { events.push("agent"); return "done"; },
    async writeReceipt(_path, receipt) {
      events.push(`receipt:${receipt.phase}`);
      receipts.push(structuredClone(receipt) as unknown as Record<string, unknown>);
    },
  };
  return { deps, events, receipts, getReplyBody: () => replyBody };
}

const request = { pullRequestUrl: "https://github.com/acme/widget/pull/4", verifyCommand: "bun test", publish: true, timeoutMinutes: 2 };

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
  expect(receipt.threadResults).toEqual([expect.objectContaining({ threadId: "thread-1", resolved: true })]);
  expect(events.at(-1)).toBe("destroy");
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
