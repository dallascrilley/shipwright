import { describe, expect, test } from "bun:test";
import {
  isRepositoryAllowed,
  parseGitHubConfig,
  parseGitHubWebhookRelayDestination,
  parseGitHubWebhookConfig,
  selectGitHubWebhookEventFamily,
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
    GITHUB_APP_INSTALLATION_ID: "42",
    SYMPHONY_REVIEWER_GITHUB_WEBHOOK_SECRET: "r".repeat(32),
    SYMPHONY_REVIEWER_GITHUB_APP_INSTALLATION_ID: "84",
    GITHUB_REPOSITORY_ALLOWLIST: "dallascrilley/shipwright",
  };

  test("binds each App secret to its exact installation and event family", () => {
    const parsed = parseGitHubWebhookConfig(webhookBase);
    expect(parsed.shipwrightApp).toEqual({
      webhookSecret: "w".repeat(32),
      installationId: 42,
    });
    expect(parsed.symphonyReviewerApp).toEqual({
      webhookSecret: "r".repeat(32),
      installationId: 84,
    });
    expect(selectGitHubWebhookEventFamily("pull_request", parsed)?.kind).toBe(
      "symphony_reviewer",
    );
    expect(selectGitHubWebhookEventFamily("check_suite", parsed)?.kind).toBe(
      "symphony_reviewer",
    );
    expect(
      selectGitHubWebhookEventFamily("pull_request_review", parsed)?.kind,
    ).toBe("shipwright");
    expect(selectGitHubWebhookEventFamily("issue_comment", parsed)?.kind).toBe(
      "shipwright",
    );
  });

  test("fails closed when either App trust tuple is incomplete", () => {
    expect(() =>
      parseGitHubWebhookConfig({
        ...webhookBase,
        SYMPHONY_REVIEWER_GITHUB_WEBHOOK_SECRET: undefined,
      }),
    ).toThrow("Symphony reviewer GitHub App webhook secret");
    expect(() =>
      parseGitHubWebhookConfig({
        ...webhookBase,
        GITHUB_APP_INSTALLATION_ID: undefined,
      }),
    ).toThrow("GitHub App installation id");
  });

  test("requires distinct secrets for every trust boundary", () => {
    expect(() =>
      parseGitHubWebhookConfig({
        ...webhookBase,
        SYMPHONY_REVIEWER_GITHUB_WEBHOOK_SECRET:
          webhookBase.GITHUB_WEBHOOK_SECRET,
      }),
    ).toThrow("must be distinct");

    const reviewCommandBase = {
      ...webhookBase,
      SHIPWRIGHT_REVIEW_COMMAND_REPOSITORY: "acme/widget",
      SHIPWRIGHT_REVIEW_OPERATOR_LOGIN: "operator",
      SHIPWRIGHT_REVIEW_OPERATOR_USER_ID: "42",
      SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_URL:
        "http://127.0.0.1:11100/api/v1/review-requests",
      SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_SECRET: "p".repeat(32),
    };
    expect(() =>
      parseGitHubWebhookConfig({
        ...reviewCommandBase,
        SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_SECRET:
          webhookBase.GITHUB_WEBHOOK_SECRET,
      }),
    ).toThrow("must be distinct");
    expect(() =>
      parseGitHubWebhookConfig({
        ...reviewCommandBase,
        SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_SECRET:
          webhookBase.SYMPHONY_REVIEWER_GITHUB_WEBHOOK_SECRET,
      }),
    ).toThrow("must be distinct");
  });

  test("leaves the Symphony relay disabled when its URL is unset", () => {
    expect(parseGitHubWebhookConfig(webhookBase).symphonyWebhookUrl).toBeUndefined();
  });

  test("leaves review commands disabled when their trust tuple is unset", () => {
    expect(parseGitHubWebhookConfig(webhookBase).reviewCommand).toBeUndefined();
  });

  test("parses an exact private review-command trust tuple", () => {
    expect(
      parseGitHubWebhookConfig({
        ...webhookBase,
        SHIPWRIGHT_REVIEW_COMMAND_REPOSITORY: " Acme/Widget ",
        SHIPWRIGHT_REVIEW_OPERATOR_LOGIN: " Operator ",
        SHIPWRIGHT_REVIEW_OPERATOR_USER_ID: "42",
        SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_URL:
          "http://127.0.0.1:11100/api/v1/review-requests",
        SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_SECRET: "p".repeat(32),
      }).reviewCommand,
    ).toEqual({
      repository: "acme/widget",
      operatorLogin: "operator",
      operatorUserId: 42,
      requestUrl: new URL(
        "http://127.0.0.1:11100/api/v1/review-requests",
      ),
      protocolSecret: "p".repeat(32),
    });
  });

  test("rejects partial or wildcard review-command configuration", () => {
    expect(() =>
      parseGitHubWebhookConfig({
        ...webhookBase,
        SHIPWRIGHT_REVIEW_COMMAND_REPOSITORY: "acme/widget",
      }),
    ).toThrow("every Shipwright review command field");
    expect(() =>
      parseGitHubWebhookConfig({
        ...webhookBase,
        SHIPWRIGHT_REVIEW_COMMAND_REPOSITORY: "acme/*",
        SHIPWRIGHT_REVIEW_OPERATOR_LOGIN: "operator",
        SHIPWRIGHT_REVIEW_OPERATOR_USER_ID: "42",
        SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_URL:
          "http://127.0.0.1:11100/api/v1/review-requests",
        SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_SECRET: "p".repeat(32),
      }),
    ).toThrow("one exact owner/repo");
  });

  test.each([
    "https://example.com/api/v1/review-requests",
    "http://127.0.0.1:11100/webhooks/github",
  ])("rejects a non-private or wrong-path review request URL: %s", (url) => {
    expect(() =>
      parseGitHubWebhookConfig({
        ...webhookBase,
        SHIPWRIGHT_REVIEW_COMMAND_REPOSITORY: "acme/widget",
        SHIPWRIGHT_REVIEW_OPERATOR_LOGIN: "operator",
        SHIPWRIGHT_REVIEW_OPERATOR_USER_ID: "42",
        SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_URL: url,
        SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_SECRET: "p".repeat(32),
      }),
    ).toThrow("SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_URL");
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
