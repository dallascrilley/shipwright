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
  test.each([".env.example", "deploy/shipwright.env.example"])(
    "%s configures both approved owners and rejects foreign repositories",
    (path) => {
      const allowlist = readExampleAllowlist(path);
      const config = parseGitHubConfig({
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY:
          "-----BEGIN PRIVATE KEY-----\nexample\n-----END PRIVATE KEY-----",
        GITHUB_REPOSITORY_ALLOWLIST: allowlist,
      });

      expect(config.allowedOwners).toEqual(
        new Set(["dallascrilley", "dallascrilleymartech"]),
      );
      expect(config.allowedRepositories).toEqual(new Set());
      expect(isRepositoryAllowed(config, "dallascrilley/shipwright")).toBe(
        true,
      );
      expect(
        isRepositoryAllowed(config, "DallasCrilleyMarTech/example-service"),
      ).toBe(true);
      expect(isRepositoryAllowed(config, "external/example")).toBe(false);
    },
  );
});
