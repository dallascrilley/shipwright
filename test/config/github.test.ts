import { describe, expect, test } from "bun:test";
import {
  isRepositoryAllowed,
  parseGitHubConfig,
  parseGitHubWebhookRelayDestination,
  parseGitHubWebhookConfig,
} from "../../src/config/github.js";

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

describe("parseGitHubWebhookConfig", () => {
  const webhookBase = {
    GITHUB_WEBHOOK_SECRET: "w".repeat(32),
    GITHUB_REPOSITORY_ALLOWLIST: "dallascrilley/shipwright",
  };

  test("leaves the Symphony relay disabled when its URL is unset", () => {
    expect(parseGitHubWebhookConfig(webhookBase).symphonyWebhookUrl).toBeUndefined();
  });

  test("normalizes the configured private Symphony webhook URL", () => {
    expect(
      parseGitHubWebhookConfig({
        ...webhookBase,
        SHIPWRIGHT_SYMPHONY_WEBHOOK_URL:
          "  http://127.0.0.1:11100/webhooks/github  ",
      }).symphonyWebhookUrl,
    ).toBe("http://127.0.0.1:11100/webhooks/github");
  });

  test.each([
    "not a URL",
    "https://example.com/webhooks/github",
    "http://private.internal/webhooks/github",
  ])("rejects an invalid configured Symphony webhook URL: %s", (url) => {
    expect(() =>
      parseGitHubWebhookConfig({
        ...webhookBase,
        SHIPWRIGHT_SYMPHONY_WEBHOOK_URL: url,
      }),
    ).toThrow("SHIPWRIGHT_SYMPHONY_WEBHOOK_URL");
  });

  test("classifies an unset relay destination as disabled", () => {
    expect(parseGitHubWebhookRelayDestination(undefined)).toEqual({
      kind: "disabled",
    });
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
