import { expect, test } from "bun:test";
import {
  authorizeIssue,
  authorizePullRequest,
  buildInstallationAuthOptions,
  extractInstallationToken,
  validateInstallationRepositories,
  type GitHubTransport,
} from "../../src/github/app-client.js";
import { isRepositoryAllowed, type GitHubConfig } from "../../src/config/github.js";

const requiredPermissions = {
  contents: "write",
  issues: "read",
  pull_requests: "write",
  metadata: "read",
} as const;

const allow = (repositories: string[], owners: string[] = []) =>
  (name: string) =>
    isRepositoryAllowed(
      { allowedRepositories: new Set(repositories), allowedOwners: new Set(owners) },
      name,
    );

test("installation auth avoids GitHub's broken dot-repository token narrowing", () => {
  expect(buildInstallationAuthOptions({
    installationId: 42,
  })).toEqual({
    type: "installation",
    installationId: 42,
  });
});

test("installation auth accepts only the exact required permission set", () => {
  expect(extractInstallationToken({
    token: "ghs_secret-token-value-1234567890",
    permissions: requiredPermissions,
  }, requiredPermissions)).toBe("ghs_secret-token-value-1234567890");

  expect(() => extractInstallationToken({
    token: "ghs_secret-token-value-1234567890",
    permissions: { ...requiredPermissions, workflows: "write" },
  }, requiredPermissions)).toThrow("permissions");
});

test("installation auth rejects repository access outside the operator allowlist", () => {
  expect(() => validateInstallationRepositories(
    ["DallasCrilleyMarTech/.hub"],
    allow(["dallascrilleymartech/.hub"]),
    "DallasCrilleyMarTech/.hub",
  )).not.toThrow();

  expect(() => validateInstallationRepositories(
    ["DallasCrilleyMarTech/.hub", "DallasCrilleyMarTech/other"],
    allow(["dallascrilleymartech/.hub"]),
    "DallasCrilleyMarTech/.hub",
  )).toThrow("outside the GitHub repository allowlist");

  expect(() => validateInstallationRepositories(
    ["DallasCrilleyMarTech/.hub", "DallasCrilleyMarTech/other"],
    allow([], ["dallascrilleymartech"]),
    "DallasCrilleyMarTech/.hub",
  )).not.toThrow();
});

test("authorizeIssue scopes authentication and returns immutable issue context", async () => {
  const calls: unknown[] = [];
  const transport: GitHubTransport = {
    async resolveInstallation(ref) { calls.push(["installation", ref]); return 42; },
    async createRepositoryClient(input) {
      calls.push(["client", input]);
      const client = {
        async getRepository() { return { id: 7, owner: "Acme", name: "Widget", defaultBranch: "main" }; },
        async getIssue() { return { title: "Fix bug", body: "Details", isPullRequest: false }; },
        async getBranchSha() { return "abc123"; },
        async listPullRequests() { return []; },
        async createPullRequest() { return { number: 1, url: "https://example/pr/1" }; },
        async getPullRequest() { throw new Error("unused"); },
        async listReviewThreads() { return []; },
        async listReviews() { return []; },
        async replyToReviewThread() { throw new Error("unused"); },
        async resolveReviewThread() { throw new Error("unused"); },
        async addPullRequestComment() { throw new Error("unused"); },
      };
      return {
        client,
        async withInstallationToken(action) { return action("ghs_secret-token-value-1234567890"); },
      };
    },
  };
  const config: GitHubConfig = {
    appId: 1,
    privateKey: "key",
    allowedRepositories: new Set(["acme/widget"]),
    allowedOwners: new Set(),
  };

  const authorized = await authorizeIssue(
    { owner: "acme", repo: "widget", number: 3, url: "https://github.com/acme/widget/issues/3" },
    config,
    transport,
  );

  expect(authorized.issue).toMatchObject({ owner: "Acme", repo: "Widget", baseSha: "abc123", installationId: 42 });
  let seen = "";
  await authorized.withInstallationToken(async (token) => { seen = token; });
  expect(seen).toStartWith("ghs_");
  expect(calls[1]).toEqual(["client", {
    installationId: 42,
    owner: "acme",
    repo: "widget",
    permissions: { contents: "write", issues: "read", pull_requests: "write", metadata: "read" },
  }]);
});

test("authorizePullRequest returns exact same-repository head and review context", async () => {
  const transport: GitHubTransport = {
    async resolveInstallation() { return 9; },
    async createRepositoryClient() {
      return {
        client: {
          async getRepository() { return { id: 1, owner: "Acme", name: "Widget", defaultBranch: "main" }; },
          async getIssue() { throw new Error("unused"); },
          async getBranchSha() { return "head1"; },
          async listPullRequests() { return []; },
          async createPullRequest() { throw new Error("unused"); },
          async getPullRequest() {
            return { title: "PR", body: "body", state: "open", draft: false, baseBranch: "main", baseSha: "base1", headBranch: "feature", headSha: "head1", headOwner: "Acme", headRepo: "Widget" };
          },
          async listReviewThreads() { return [{ id: "t1", isResolved: false, isOutdated: false, path: "a.ts", line: 1, comments: [] }]; },
          async listReviews() { return [{ id: "r1", state: "CHANGES_REQUESTED", body: "review", author: "reviewer" }]; },
          async replyToReviewThread() { throw new Error("unused"); },
          async resolveReviewThread() { throw new Error("unused"); },
          async addPullRequestComment() { throw new Error("unused"); },
        },
        async withInstallationToken(action) { return action("secret"); },
      };
    },
  };
  const config: GitHubConfig = { appId: 1, privateKey: "key", allowedRepositories: new Set(["acme/widget"]), allowedOwners: new Set() };
  const authorized = await authorizePullRequest(
    { owner: "acme", repo: "widget", number: 4, url: "https://github.com/acme/widget/pull/4" },
    config,
    transport,
  );
  expect(authorized.pullRequest).toMatchObject({ headBranch: "feature", headSha: "head1", installationId: 9 });
  expect(authorized.reviewThreads).toHaveLength(1);
  expect(authorized.reviews[0]?.state).toBe("CHANGES_REQUESTED");
});

test("authorizePullRequest rejects fork heads", async () => {
  const transport: GitHubTransport = {
    async resolveInstallation() { return 9; },
    async createRepositoryClient() {
      return {
        client: {
          async getRepository() { return { id: 1, owner: "Acme", name: "Widget", defaultBranch: "main" }; },
          async getIssue() { throw new Error("unused"); },
          async getBranchSha() { return "head1"; },
          async listPullRequests() { return []; },
          async createPullRequest() { throw new Error("unused"); },
          async getPullRequest() { return { title: "PR", body: "", state: "open", draft: false, baseBranch: "main", baseSha: "base1", headBranch: "feature", headSha: "head1", headOwner: "Other", headRepo: "Fork" }; },
          async listReviewThreads() { return []; },
          async listReviews() { return []; },
          async replyToReviewThread() { throw new Error("unused"); },
          async resolveReviewThread() { throw new Error("unused"); },
          async addPullRequestComment() { throw new Error("unused"); },
        },
        async withInstallationToken(action) { return action("secret"); },
      };
    },
  };
  const config: GitHubConfig = { appId: 1, privateKey: "key", allowedRepositories: new Set(["acme/widget"]), allowedOwners: new Set() };
  await expect(authorizePullRequest(
    { owner: "acme", repo: "widget", number: 4, url: "https://github.com/acme/widget/pull/4" },
    config,
    transport,
  )).rejects.toThrow("fork");
});

test("authorizeIssue rejects repositories outside the allowlist before API access", async () => {
  let called = false;
  const transport: GitHubTransport = {
    async resolveInstallation() { called = true; return 1; },
    async createRepositoryClient() { throw new Error("unreachable"); },
  };
  const config: GitHubConfig = { appId: 1, privateKey: "key", allowedRepositories: new Set(["other/repo"]), allowedOwners: new Set() };
  await expect(authorizeIssue(
    { owner: "acme", repo: "widget", number: 3, url: "https://github.com/acme/widget/issues/3" },
    config,
    transport,
  )).rejects.toThrow("allowlist");
  expect(called).toBeFalse();
});
