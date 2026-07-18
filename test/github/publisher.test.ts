import { expect, test } from "bun:test";
import { openOrReusePullRequest, pullRequestBody } from "../../src/github/publisher.js";

test("pullRequestBody records issue and observed verification", () => {
  expect(pullRequestBody({ issueNumber: 9, runId: "abcd", verifyCommand: "bun test", changedFiles: ["src/a.ts"] }))
    .toContain("Fixes #9");
});

test("openOrReusePullRequest returns a matching existing PR", async () => {
  let created = false;
  const result = await openOrReusePullRequest({
    async listPullRequests() { return [{ number: 4, url: "https://example/pr/4", headSha: "sha1" }]; },
    async createPullRequest() { created = true; throw new Error("unreachable"); },
  }, { owner: "a", repo: "b", title: "Fix", issueNumber: 1, branch: "agent/x", baseBranch: "main", commitSha: "sha1", body: "body" });
  expect(result.url).toEndWith("/4");
  expect(created).toBeFalse();
});

test("openOrReusePullRequest fails closed on an existing mismatched head", async () => {
  await expect(openOrReusePullRequest({
    async listPullRequests() { return [{ number: 4, url: "https://example/pr/4", headSha: "other" }]; },
    async createPullRequest() { throw new Error("unreachable"); },
  }, { owner: "a", repo: "b", title: "Fix", issueNumber: 1, branch: "agent/x", baseBranch: "main", commitSha: "sha1", body: "body" }))
    .rejects.toThrow("different commit");
});
