import { readFileSync } from "node:fs";

export interface GitHubConfig {
  appId: number;
  privateKey: string;
  installationId?: number;
  allowedRepositories: Set<string>;
  allowedOwners: Set<string>;
}

export interface GitHubWebhookConfig {
  webhookSecret: string;
  allowedRepositories: Set<string>;
  allowedOwners: Set<string>;
  /**
   * Reviewer identity authorized to trigger repair from a submitted review.
   * The `pull_request_review` payload identifies the reviewer as a bot *user*
   * (login plus user id), never as an App id, so identity is pinned on the
   * lowercased login and optionally the numeric user id. When this is unset,
   * review deliveries are rejected rather than trusting any bot reviewer.
   */
  expectedReviewerLogin?: string;
  expectedReviewerUserId?: number;
  /** When set, review deliveries must carry exactly this installation id. */
  installationId?: number;
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
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!webhookSecret || webhookSecret.length < 32) {
    throw new Error("GitHub webhook secret must be at least 32 characters");
  }
  const { repositories, owners } = parseAllowedRepositories(env);
  const expectedReviewerLogin =
    env.GITHUB_REVIEW_BOT_LOGIN?.trim().toLowerCase() || undefined;
  return {
    webhookSecret,
    allowedRepositories: repositories,
    allowedOwners: owners,
    expectedReviewerLogin,
    expectedReviewerUserId: env.GITHUB_REVIEW_BOT_USER_ID
      ? parsePositiveInteger(
          env.GITHUB_REVIEW_BOT_USER_ID,
          "GITHUB_REVIEW_BOT_USER_ID",
        )
      : undefined,
    installationId: env.GITHUB_APP_INSTALLATION_ID
      ? parsePositiveInteger(
          env.GITHUB_APP_INSTALLATION_ID,
          "GITHUB_APP_INSTALLATION_ID",
        )
      : undefined,
  };
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
