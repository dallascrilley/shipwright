import { describe, expect, test, vi } from "vitest";

import type { GitHubConfig } from "../../src/config/github.js";
import type {
  GitHubAccessibleRepository,
  GitHubTransport,
} from "../../src/github/app-client.js";
import { AgentRepositoryCatalog } from "./repository-catalog";

const config: GitHubConfig = {
  appId: 1,
  privateKey: "test-key",
  allowedRepositories: new Set(["exact-owner/exact-repo"]),
  allowedOwners: new Set(["dallascrilley", "dallascrilleymartech"]),
};

function createCatalog(
  repositories: GitHubAccessibleRepository[],
  overrides: Partial<
    ConstructorParameters<typeof AgentRepositoryCatalog>[0]
  > = {},
) {
  const transport = {
    listAccessibleRepositories: vi.fn(async () => repositories),
  } as unknown as GitHubTransport;
  return {
    transport,
    catalog: new AgentRepositoryCatalog({
      isDemoMode: () => false,
      loadGitHubConfig: () => config,
      createTransport: () => transport,
      ...overrides,
    }),
  };
}

describe("AgentRepositoryCatalog", () => {
  test("returns sorted selectable repositories from exact and approved owner scopes", async () => {
    const { catalog } = createCatalog([
      {
        fullName: "DallasCrilleyMarTech/JCS-Production-OS",
        defaultBranch: "develop",
        visibility: "private",
        archived: false,
      },
      {
        fullName: "Exact-Owner/Exact-Repo",
        defaultBranch: "main",
        visibility: "internal",
        archived: false,
      },
      {
        fullName: "DallasCrilley/Shipwright",
        defaultBranch: "main",
        visibility: "public",
        archived: false,
      },
    ]);

    await expect(catalog.list()).resolves.toEqual({
      ok: true,
      repositories: [
        {
          repository: "dallascrilley/shipwright",
          owner: "dallascrilley",
          name: "shipwright",
          defaultBranch: "main",
          visibility: "public",
          archived: false,
          selectable: true,
        },
        {
          repository: "dallascrilleymartech/jcs-production-os",
          owner: "dallascrilleymartech",
          name: "jcs-production-os",
          defaultBranch: "develop",
          visibility: "private",
          archived: false,
          selectable: true,
        },
        {
          repository: "exact-owner/exact-repo",
          owner: "exact-owner",
          name: "exact-repo",
          defaultBranch: "main",
          visibility: "internal",
          archived: false,
          selectable: true,
        },
      ],
    });
  });

  test("filters foreign owners, deduplicates canonical names, and retains archived rows as unavailable", async () => {
    const { catalog } = createCatalog([
      {
        fullName: "Foreign/Nope",
        defaultBranch: "main",
        visibility: "public",
        archived: false,
      },
      {
        fullName: "DallasCrilley/Shipwright",
        defaultBranch: "main",
        visibility: "private",
        archived: false,
      },
      {
        fullName: "dallascrilley/shipwright",
        defaultBranch: "main",
        visibility: "private",
        archived: false,
      },
      {
        fullName: "DallasCrilley/Archive",
        defaultBranch: "main",
        visibility: "private",
        archived: true,
      },
    ]);

    const result = await catalog.list();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ready repository catalog");
    expect(result.repositories).toHaveLength(2);
    expect(result.repositories[0]).toMatchObject({
      repository: "dallascrilley/archive",
      archived: true,
      selectable: false,
    });
    expect(result.repositories[1]?.repository).toBe("dallascrilley/shipwright");
  });

  test("fails closed with safe typed errors for configuration, empty access, and GitHub failures", async () => {
    const missing = new AgentRepositoryCatalog({
      isDemoMode: () => false,
      loadGitHubConfig: () => null,
      createTransport: () => {
        throw new Error("unreachable");
      },
    });
    await expect(missing.list()).resolves.toMatchObject({
      ok: false,
      code: "not_configured",
    });

    const invalid = new AgentRepositoryCatalog({
      isDemoMode: () => false,
      loadGitHubConfig: () => {
        throw new Error("private key path /secret/location is unreadable");
      },
      createTransport: () => {
        throw new Error("unreachable");
      },
    });
    const invalidResult = await invalid.list();
    expect(invalidResult).toMatchObject({
      ok: false,
      code: "not_configured",
    });
    expect(JSON.stringify(invalidResult)).not.toContain("/secret/location");

    const { catalog: empty } = createCatalog([]);
    await expect(empty.list()).resolves.toMatchObject({
      ok: false,
      code: "no_repositories",
    });

    const failing = new AgentRepositoryCatalog({
      isDemoMode: () => false,
      loadGitHubConfig: () => config,
      createTransport: () =>
        ({
          listAccessibleRepositories: async () => {
            throw new Error("example-upstream-secret rejected the request");
          },
        }) as unknown as GitHubTransport,
    });
    const failure = await failing.list();
    expect(failure).toMatchObject({ ok: false, code: "github_unavailable" });
    expect(JSON.stringify(failure)).not.toContain("example-upstream-secret");
  });

  test("assertSelectable rejects unknown and archived repositories", async () => {
    const { catalog } = createCatalog([
      {
        fullName: "DallasCrilley/Archive",
        defaultBranch: "main",
        visibility: "private",
        archived: true,
      },
    ]);

    await expect(catalog.assertSelectable("foreign/nope")).rejects.toThrow(
      /accessible/i,
    );
    await expect(
      catalog.assertSelectable("dallascrilley/archive"),
    ).rejects.toThrow(/archived/i);
  });
});
