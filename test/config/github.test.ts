import { describe, expect, test } from "bun:test";
import { isRepositoryAllowed, parseGitHubConfig } from "../../src/config/github.js";

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
    expect(config.allowedOwners).toEqual(new Set());
  });

  test("requires exactly one private key source", () => {
    expect(() =>
      parseGitHubConfig({ ...base, GITHUB_APP_PRIVATE_KEY_PATH: "/tmp/key.pem" }),
    ).toThrow("exactly one");
    expect(() => parseGitHubConfig({ ...base, GITHUB_APP_PRIVATE_KEY: undefined })).toThrow(
      "private key",
    );
  });

  test("rejects a bare wildcard, a wildcard owner, and an empty allowlist", () => {
    expect(() => parseGitHubConfig({ ...base, GITHUB_REPOSITORY_ALLOWLIST: "*" })).toThrow(
      "allowlist",
    );
    expect(() => parseGitHubConfig({ ...base, GITHUB_REPOSITORY_ALLOWLIST: "*/*" })).toThrow(
      "allowlist",
    );
    expect(() => parseGitHubConfig({ ...base, GITHUB_REPOSITORY_ALLOWLIST: "" })).toThrow(
      "allowlist",
    );
  });

  test("accepts owner-scoped wildcards alongside exact entries", () => {
    const config = parseGitHubConfig({
      ...base,
      GITHUB_REPOSITORY_ALLOWLIST: "DallasCrilleyMarTech/*, dallascrilley/shipwright",
    });
    expect(config.allowedOwners).toEqual(new Set(["dallascrilleymartech"]));
    expect(config.allowedRepositories).toEqual(new Set(["dallascrilley/shipwright"]));
  });
});

describe("isRepositoryAllowed", () => {
  const scope = {
    allowedRepositories: new Set(["dallascrilley/shipwright"]),
    allowedOwners: new Set(["dallascrilleymartech"]),
  };

  test("permits an exact match regardless of case", () => {
    expect(isRepositoryAllowed(scope, "DallasCrilley/Shipwright")).toBe(true);
  });

  test("permits any repository under an owner-scoped wildcard", () => {
    expect(isRepositoryAllowed(scope, "DallasCrilleyMarTech/.hub")).toBe(true);
    expect(isRepositoryAllowed(scope, "dallascrilleymartech/studio-ops")).toBe(true);
  });

  test("denies repositories with no matching entry or owner scope", () => {
    expect(isRepositoryAllowed(scope, "dallascrilley/other")).toBe(false);
    expect(isRepositoryAllowed(scope, "someoneelse/repo")).toBe(false);
    expect(isRepositoryAllowed(scope, "dallascrilleymartech")).toBe(false);
  });
});
