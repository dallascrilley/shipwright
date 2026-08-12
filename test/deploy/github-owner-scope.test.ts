import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  isRepositoryAllowed,
  parseGitHubConfig,
} from "../../src/config/github.js";

const repoRoot = resolve(import.meta.dir, "..", "..");

function readExampleAllowlist(path: string): string {
  const contents = readFileSync(resolve(repoRoot, path), "utf8");
  const line = contents
    .split("\n")
    .find((entry) => entry.startsWith("GITHUB_REPOSITORY_ALLOWLIST="));
  if (!line) throw new Error(`Missing GITHUB_REPOSITORY_ALLOWLIST in ${path}`);
  return line.slice(line.indexOf("=") + 1);
}

describe("GitHub owner-scope deployment examples", () => {
  // The shipped examples use placeholder owners on purpose, so this asserts the
  // invariant an operator inherits when they substitute their own: the allowlist
  // parses, every scope stays owner-bound, and a foreign owner is still refused.
  test.each([".env.example", "deploy/shipwright.env.example"])(
    "%s parses as an owner-bound allowlist that rejects foreign repositories",
    (path) => {
      const allowlist = readExampleAllowlist(path);
      const config = parseGitHubConfig({
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY:
          "-----BEGIN PRIVATE KEY-----\nexample\n-----END PRIVATE KEY-----",
        GITHUB_REPOSITORY_ALLOWLIST: allowlist,
      });

      expect(config.allowedOwners.size + config.allowedRepositories.size)
        .toBeGreaterThan(0);
      for (const owner of config.allowedOwners) {
        expect(owner).not.toBe("*");
        expect(owner).not.toContain("/");
      }
      for (const owner of config.allowedOwners) {
        expect(isRepositoryAllowed(config, `${owner}/any-repository`)).toBe(true);
      }
      for (const repository of config.allowedRepositories) {
        expect(isRepositoryAllowed(config, repository)).toBe(true);
      }
      expect(isRepositoryAllowed(config, "external/example")).toBe(false);
      expect(isRepositoryAllowed(config, "DallasCrilleyMarTech/example-service"))
        .toBe(false);
    },
  );

  test("a bare wildcard is rejected outright", () => {
    for (const allowlist of ["*", "*/*", "*/repo"]) {
      expect(() =>
        parseGitHubConfig({
          GITHUB_APP_ID: "123",
          GITHUB_APP_PRIVATE_KEY:
            "-----BEGIN PRIVATE KEY-----\nexample\n-----END PRIVATE KEY-----",
          GITHUB_REPOSITORY_ALLOWLIST: allowlist,
        }),
      ).toThrow("owner scopes");
    }
  });
});
