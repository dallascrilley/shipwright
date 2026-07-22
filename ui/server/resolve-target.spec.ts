import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { GitHubConfig } from "../../src/config/github.js";
import type { GitHubTransport } from "../../src/github/app-client.js";
import { resolveTarget } from "./resolve-target";

const issueUrl = "https://github.com/dallascrilley/example/issues/12";
const pullUrl = "https://github.com/dallascrilley/example/pull/9";

const config: GitHubConfig = {
  appId: 1,
  privateKey: "test-key",
  allowedRepositories: new Set(["dallascrilley/example"]),
  allowedOwners: new Set(),
};

let savedDemoEnv: string | undefined;


beforeEach(() => {
  // guard:allow-env-credential — tests isolate deploy-level non-secret demo mode.
  savedDemoEnv = process.env.SHIPWRIGHT_UI_DEMO;
  // guard:allow-env-credential — tests isolate deploy-level non-secret demo mode.
  delete process.env.SHIPWRIGHT_UI_DEMO;
});

afterEach(() => {
  if (savedDemoEnv === undefined) {
    // guard:allow-env-credential — tests restore deploy-level non-secret demo mode.
    delete process.env.SHIPWRIGHT_UI_DEMO;
  } else {
    // guard:allow-env-credential — tests restore deploy-level non-secret demo mode.
    process.env.SHIPWRIGHT_UI_DEMO = savedDemoEnv;
  }
  vi.restoreAllMocks();
});

describe("resolveTarget", () => {
  test("rejects non-canonical URLs without network", async () => {
    const result = await resolveTarget("https://gitlab.com/a/b/issues/1");
    expect(result.allowed).toBe(false);
    expect(result.denyReason).toMatch(/canonical/i);
  });

  test("demo mode returns parse-only pin without GitHub", async () => {
    // guard:allow-env-credential — tests enable deploy-level non-secret demo mode.
    process.env.SHIPWRIGHT_UI_DEMO = "1";
    const result = await resolveTarget(issueUrl, {
      loadGitHubConfig: () => {
        throw new Error("should not load config in demo");
      },
    });
    expect(result).toMatchObject({
      allowed: true,
      kind: "issue",
      owner: "dallascrilley",
      repo: "example",
      number: 12,
      title: "Demo issue #12",
      pinned: { headSha: "0000000000000000000000000000000000000000" },
    });
  });

  test("live mode without GitHub config returns parse-only allowed", async () => {
    const result = await resolveTarget(issueUrl, {
      isDemoMode: () => false,
      loadGitHubConfig: () => null,
    });
    expect(result).toMatchObject({
      allowed: true,
      kind: "issue",
      number: 12,
    });
    expect(result.title).toBeUndefined();
  });

  test("live issue path returns title and pinned head from authorizeIssue", async () => {
    const authorizeIssue = vi.fn(async () => ({
      issue: {
        owner: "dallascrilley",
        repo: "example",
        number: 12,
        url: issueUrl,
        title: "Fix the widget",
        body: "",
        defaultBranch: "main",
        baseSha: "abc123def456",
        installationId: 9,
      },
      repositoryClient: {} as never,
      withInstallationToken: async <T>(action: (token: string) => Promise<T>) =>
        action("token"),
    }));

    const result = await resolveTarget(issueUrl, {
      isDemoMode: () => false,
      loadGitHubConfig: () => config,
      createTransport: () => ({}) as GitHubTransport,
      authorizeIssue,
      authorizePullRequest: vi.fn(),
    });

    expect(authorizeIssue).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      allowed: true,
      title: "Fix the widget",
      pinned: { headSha: "abc123def456" },
    });
  });

  test("live pull path returns open thread count", async () => {
    const authorizePullRequest = vi.fn(async () => ({
      pullRequest: {
        owner: "dallascrilley",
        repo: "example",
        number: 9,
        url: pullUrl,
        title: "Review me",
        body: "",
        baseBranch: "main",
        baseSha: "base",
        headBranch: "feat",
        headSha: "headsha1",
        installationId: 9,
      },
      reviewThreads: [
        { id: "t1", isResolved: false, isOutdated: false, path: "a.ts", line: 1, comments: [] },
        { id: "t2", isResolved: true, isOutdated: false, path: "b.ts", line: 2, comments: [] },
      ],
      reviews: [],
      repositoryClient: {} as never,
      withInstallationToken: async <T>(action: (token: string) => Promise<T>) =>
        action("token"),
    }));

    const result = await resolveTarget(pullUrl, {
      isDemoMode: () => false,
      loadGitHubConfig: () => config,
      createTransport: () => ({}) as GitHubTransport,
      authorizeIssue: vi.fn(),
      authorizePullRequest,
    });

    expect(result).toMatchObject({
      allowed: true,
      kind: "pull",
      title: "Review me",
      pinned: { headSha: "headsha1", openThreadCount: 1 },
    });
  });

  test("maps allowlist denial to denyReason", async () => {
    const result = await resolveTarget(issueUrl, {
      isDemoMode: () => false,
      loadGitHubConfig: () => config,
      createTransport: () => ({}) as GitHubTransport,
      authorizeIssue: vi.fn(async () => {
        throw new Error("repository is not in the GitHub repository allowlist");
      }),
      authorizePullRequest: vi.fn(),
    });

    expect(result.allowed).toBe(false);
    expect(result.denyReason).toMatch(/allowlist/i);
    expect(result.owner).toBe("dallascrilley");
  });

  test("PR run-start path skips review thread listing", async () => {
    const authorizePullRequest = vi.fn();
    const getPullRequest = vi.fn(async () => ({
      title: "Review me",
      body: "",
      state: "open",
      draft: false,
      baseBranch: "main",
      baseSha: "base",
      headBranch: "feat",
      headSha: "headsha1",
      headOwner: "dallascrilley",
      headRepo: "example",
    }));
    const transport = {
      resolveInstallation: vi.fn(async () => 9),
      createRepositoryClient: vi.fn(async () => ({
        client: {
          getRepository: async () => ({
            id: 1,
            owner: "dallascrilley",
            name: "example",
            defaultBranch: "main",
          }),
          getPullRequest,
        },
        withInstallationToken: async <T>(action: (token: string) => Promise<T>) =>
          action("token"),
      })),
    } as unknown as GitHubTransport;

    const result = await resolveTarget(
      pullUrl,
      {
        isDemoMode: () => false,
        loadGitHubConfig: () => config,
        createTransport: () => transport,
        authorizeIssue: vi.fn(),
        authorizePullRequest,
      },
      { includeReviewThreads: false },
    );

    expect(authorizePullRequest).not.toHaveBeenCalled();
    expect(getPullRequest).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      allowed: true,
      title: "Review me",
      pinned: { headSha: "headsha1" },
    });
    expect(result.pinned?.openThreadCount).toBeUndefined();
  });
});
