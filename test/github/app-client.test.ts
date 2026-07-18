import { expect, test } from "bun:test";
import { authorizeIssue, type GitHubTransport } from "../../src/github/app-client.js";
import type { GitHubConfig } from "../../src/config/github.js";

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

test("authorizeIssue rejects repositories outside the allowlist before API access", async () => {
  let called = false;
  const transport: GitHubTransport = {
    async resolveInstallation() { called = true; return 1; },
    async createRepositoryClient() { throw new Error("unreachable"); },
  };
  const config: GitHubConfig = { appId: 1, privateKey: "key", allowedRepositories: new Set(["other/repo"]) };
  await expect(authorizeIssue(
    { owner: "acme", repo: "widget", number: 3, url: "https://github.com/acme/widget/issues/3" },
    config,
    transport,
  )).rejects.toThrow("allowlist");
  expect(called).toBeFalse();
});
