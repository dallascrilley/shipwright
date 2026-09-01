import { readFileSync } from "node:fs";
import { isIP } from "node:net";

export interface GitHubConfig {
  appId: number;
  privateKey: string;
  installationId?: number;
  allowedRepositories: Set<string>;
  allowedOwners: Set<string>;
}

export type GitHubWebhookTrust = {
  webhookSecret: string;
  installationId: number;
};

export interface GitHubWebhookConfig {
  shipwrightApp: GitHubWebhookTrust;
  symphonyReviewerApp: GitHubWebhookTrust;
  allowedRepositories: Set<string>;
  allowedOwners: Set<string>;
  /** Optional private Symphony receiver. The HTTP adapter validates it before use. */
  symphonyWebhookUrl?: string;
  /**
   * Reviewer identity authorized to trigger repair from a submitted review.
   * The `pull_request_review` payload identifies the reviewer as a bot *user*
   * (login plus user id), never as an App id, so identity is pinned on the
   * lowercased login and optionally the numeric user id. When this is unset,
   * review deliveries are rejected rather than trusting any bot reviewer.
   */
  expectedReviewerLogin?: string;
  expectedReviewerUserId?: number;
  reviewCommand?: ReviewCommandConfig;
}

export interface ReviewCommandConfig {
  repository: string;
  operatorLogin: string;
  operatorUserId: number;
  requestUrl: URL;
  protocolSecret: string;
}

export interface GitHubWebhookIngressConfig extends RepositoryScope {
  webhookSecret: string;
  installationId: number;
  symphonyWebhookUrl?: string;
  expectedReviewerLogin?: string;
  expectedReviewerUserId?: number;
}

export type GitHubWebhookEventFamily =
  | { kind: "shipwright"; trust: GitHubWebhookTrust }
  | { kind: "symphony_reviewer"; trust: GitHubWebhookTrust };

export function selectGitHubWebhookEventFamily(
  event: string,
  config: GitHubWebhookConfig,
): GitHubWebhookEventFamily | undefined {
  if (event === "pull_request" || event === "check_suite") {
    return { kind: "symphony_reviewer", trust: config.symphonyReviewerApp };
  }
  if (
    event === "issues" ||
    event === "pull_request_review" ||
    event === "issue_comment"
  ) {
    return { kind: "shipwright", trust: config.shipwrightApp };
  }
  return undefined;
}

export function selectGitHubWebhookIngressConfig(
  config: GitHubWebhookConfig,
  family: GitHubWebhookEventFamily,
): GitHubWebhookIngressConfig {
  return {
    ...family.trust,
    allowedRepositories: config.allowedRepositories,
    allowedOwners: config.allowedOwners,
    symphonyWebhookUrl: config.symphonyWebhookUrl,
    expectedReviewerLogin: config.expectedReviewerLogin,
    expectedReviewerUserId: config.expectedReviewerUserId,
  };
}

export type GitHubWebhookRelayDestination =
  | { kind: "disabled" }
  | { kind: "invalid" }
  | { kind: "private"; url: URL };

export function parseGitHubWebhookRelayDestination(
  value: unknown,
): GitHubWebhookRelayDestination {
  if (value === undefined || value === null || value === "") {
    return { kind: "disabled" };
  }
  if (typeof value !== "string") return { kind: "invalid" };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "invalid" };
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/webhooks/github" ||
    url.search !== "" ||
    url.hash !== "" ||
    !isPrivateHostname(url)
  ) {
    return { kind: "invalid" };
  }
  return { kind: "private", url };
}

/** Exact `owner/repo` names plus owners granted an `owner/*` scope. */
export interface RepositoryScope {
  allowedRepositories: ReadonlySet<string>;
  allowedOwners: ReadonlySet<string>;
}

/**
 * A repository is permitted when it matches an exact allowlist entry or when its
 * owner carries an "owner/star" scope. Owner scopes are owner-bound by
 * construction (the parser rejects a bare star or a star owner), so this never
 * means "any repository".
 */
export function isRepositoryAllowed(scope: RepositoryScope, fullName: string): boolean {
  const canonical = fullName.trim().toLowerCase();
  if (scope.allowedRepositories.has(canonical)) return true;
  const slash = canonical.indexOf("/");
  if (slash <= 0 || slash >= canonical.length - 1) return false;
  return scope.allowedOwners.has(canonical.slice(0, slash));
}

type Environment = Record<string, string | undefined>;

interface ParsedAllowlist {
  repositories: Set<string>;
  owners: Set<string>;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseGitHubConfig(env: Environment = process.env): GitHubConfig {
  const inlineKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  if (Boolean(inlineKey) === Boolean(keyPath)) {
    throw new Error("configure exactly one GitHub App private key source");
  }

  const { repositories, owners } = parseAllowedRepositories(env);

  const installationId = env.GITHUB_APP_INSTALLATION_ID
    ? parsePositiveInteger(env.GITHUB_APP_INSTALLATION_ID, "GITHUB_APP_INSTALLATION_ID")
    : undefined;

  return {
    appId: parsePositiveInteger(env.GITHUB_APP_ID, "GITHUB_APP_ID"),
    privateKey: inlineKey ?? readFileSync(keyPath!, "utf8"),
    installationId,
    allowedRepositories: repositories,
    allowedOwners: owners,
  };
}

export function parseGitHubWebhookConfig(
  env: Environment = process.env,
): GitHubWebhookConfig {
  const shipwrightApp = parseWebhookTrust(
    env.GITHUB_WEBHOOK_SECRET,
    env.GITHUB_APP_INSTALLATION_ID,
    "GitHub App",
  );
  const symphonyReviewerApp = parseWebhookTrust(
    env.SYMPHONY_REVIEWER_GITHUB_WEBHOOK_SECRET,
    env.SYMPHONY_REVIEWER_GITHUB_APP_INSTALLATION_ID,
    "Symphony reviewer GitHub App",
  );
  const { repositories, owners } = parseAllowedRepositories(env);
  const expectedReviewerLogin =
    env.GITHUB_REVIEW_BOT_LOGIN?.trim().toLowerCase() || undefined;
  const symphonyWebhookUrl =
    env.SHIPWRIGHT_SYMPHONY_WEBHOOK_URL?.trim() || undefined;
  if (
    symphonyWebhookUrl !== undefined &&
    parseGitHubWebhookRelayDestination(symphonyWebhookUrl).kind !== "private"
  ) {
    throw new Error(
      "SHIPWRIGHT_SYMPHONY_WEBHOOK_URL must be a private /webhooks/github URL",
    );
  }
  const reviewCommand = parseReviewCommandConfig(env);
  assertDistinctWebhookSecrets(shipwrightApp, symphonyReviewerApp, reviewCommand);
  return {
    shipwrightApp,
    symphonyReviewerApp,
    allowedRepositories: repositories,
    allowedOwners: owners,
    symphonyWebhookUrl,
    expectedReviewerLogin,
    expectedReviewerUserId: env.GITHUB_REVIEW_BOT_USER_ID
      ? parsePositiveInteger(
          env.GITHUB_REVIEW_BOT_USER_ID,
          "GITHUB_REVIEW_BOT_USER_ID",
        )
      : undefined,
    reviewCommand,
  };
}

function assertDistinctWebhookSecrets(
  shipwrightApp: GitHubWebhookTrust,
  symphonyReviewerApp: GitHubWebhookTrust,
  reviewCommand: ReviewCommandConfig | undefined,
): void {
  const secrets = [
    shipwrightApp.webhookSecret,
    symphonyReviewerApp.webhookSecret,
    ...(reviewCommand === undefined ? [] : [reviewCommand.protocolSecret]),
  ];
  if (new Set(secrets).size !== secrets.length) {
    throw new Error(
      "Shipwright App, Symphony reviewer App, and review request secrets must be distinct",
    );
  }
}

function parseReviewCommandConfig(
  env: Environment,
): ReviewCommandConfig | undefined {
  const values = {
    repository: env.SHIPWRIGHT_REVIEW_COMMAND_REPOSITORY?.trim(),
    operatorLogin: env.SHIPWRIGHT_REVIEW_OPERATOR_LOGIN?.trim(),
    operatorUserId: env.SHIPWRIGHT_REVIEW_OPERATOR_USER_ID?.trim(),
    requestUrl: env.SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_URL?.trim(),
    protocolSecret: env.SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_SECRET?.trim(),
  };
  const configured = Object.values(values).filter(Boolean).length;
  if (configured === 0) return undefined;
  if (configured !== Object.keys(values).length) {
    throw new Error("configure every Shipwright review command field or none of them");
  }
  const repository = parseExactRepository(
    values.repository!,
    "SHIPWRIGHT_REVIEW_COMMAND_REPOSITORY",
  );
  const operatorLogin = values.operatorLogin!.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(operatorLogin)) {
    throw new Error("SHIPWRIGHT_REVIEW_OPERATOR_LOGIN must be a GitHub login");
  }
  const protocolSecret = values.protocolSecret!;
  if (protocolSecret.length < 32) {
    throw new Error(
      "SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_SECRET must be at least 32 characters",
    );
  }
  return {
    repository,
    operatorLogin,
    operatorUserId: parsePositiveInteger(
      values.operatorUserId,
      "SHIPWRIGHT_REVIEW_OPERATOR_USER_ID",
    ),
    requestUrl: parsePrivateReviewRequestUrl(values.requestUrl!),
    protocolSecret,
  };
}

function parseExactRepository(value: string, name: string): string {
  const canonical = value.toLowerCase();
  if (!/^[^/*\s]+\/[^/*\s]+$/.test(canonical)) {
    throw new Error(`${name} must be one exact owner/repo`);
  }
  return canonical;
}

function parsePrivateReviewRequestUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_URL must be a private /api/v1/review-requests URL",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/api/v1/review-requests" ||
    url.search !== "" ||
    url.hash !== "" ||
    !isPrivateHostname(url)
  ) {
    throw new Error(
      "SHIPWRIGHT_SYMPHONY_REVIEW_REQUEST_URL must be a private /api/v1/review-requests URL",
    );
  }
  return url;
}

function parseWebhookTrust(
  secretValue: string | undefined,
  installationValue: string | undefined,
  label: string,
): GitHubWebhookTrust {
  const webhookSecret = secretValue?.trim();
  if (!webhookSecret || webhookSecret.length < 32) {
    throw new Error(`${label} webhook secret must be at least 32 characters`);
  }
  return {
    webhookSecret,
    installationId: parsePositiveInteger(
      installationValue,
      `${label} installation id`,
    ),
  };
}

function isPrivateHostname(url: URL): boolean {
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
  if (hostname === "localhost") return true;

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) return isPrivateIpv4(hostname);
  if (ipVersion === 6) return isPrivateIpv6(hostname);
  return url.protocol === "https:" && hostname.endsWith(".ts.net");
}

function isPrivateIpv4(hostname: string): boolean {
  const [first = -1, second = -1] = hostname
    .split(".")
    .map((part) => Number(part));
  return (
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  if (hostname === "::1") return true;
  const firstGroup = hostname.split(":", 1)[0] ?? "";
  const prefix = Number.parseInt(firstGroup, 16);
  return (
    Number.isFinite(prefix) &&
    ((prefix & 0xfe00) === 0xfc00 || (prefix & 0xffc0) === 0xfe80)
  );
}

function parseAllowedRepositories(env: Environment): ParsedAllowlist {
  const entries = (env.GITHUB_REPOSITORY_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (
    entries.length === 0 ||
    entries.some((entry) => !/^[a-z0-9_.-]+\/(?:\*|[a-z0-9_.-]+)$/.test(entry))
  ) {
    throw new Error(
      "GitHub repository allowlist must contain exact owner/repo entries or owner/* owner scopes",
    );
  }
  const repositories = new Set<string>();
  const owners = new Set<string>();
  for (const entry of entries) {
    const slash = entry.indexOf("/");
    const owner = entry.slice(0, slash);
    const repo = entry.slice(slash + 1);
    if (repo === "*") owners.add(owner);
    else repositories.add(entry);
  }
  return { repositories, owners };
}
