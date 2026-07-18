import { describe, expect, test } from "bun:test";
import { parseGitHubConfig } from "../../src/config/github.js";

const base = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
  GITHUB_REPOSITORY_ALLOWLIST: "Owner/Repo, another/project",
};

describe("parseGitHubConfig", () => {
  test("normalizes an exact repository allowlist", () => {
    const config = parseGitHubConfig(base);
    expect(config.appId).toBe(123);
    expect(config.allowedRepositories).toEqual(new Set(["owner/repo", "another/project"]));
  });

  test("requires exactly one private key source", () => {
    expect(() =>
      parseGitHubConfig({ ...base, GITHUB_APP_PRIVATE_KEY_PATH: "/tmp/key.pem" }),
    ).toThrow("exactly one");
    expect(() => parseGitHubConfig({ ...base, GITHUB_APP_PRIVATE_KEY: undefined })).toThrow(
      "private key",
    );
  });

  test("rejects wildcard and empty allowlists", () => {
    expect(() => parseGitHubConfig({ ...base, GITHUB_REPOSITORY_ALLOWLIST: "*" })).toThrow(
      "allowlist",
    );
    expect(() => parseGitHubConfig({ ...base, GITHUB_REPOSITORY_ALLOWLIST: "" })).toThrow(
      "allowlist",
    );
  });
});
