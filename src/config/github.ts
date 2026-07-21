import { readFileSync } from "node:fs";

export interface GitHubConfig {
  appId: number;
  privateKey: string;
  installationId?: number;
  allowedRepositories: Set<string>;
}

export interface GitHubWebhookConfig {
  webhookSecret: string;
  allowedRepositories: Set<string>;
}

type Environment = Record<string, string | undefined>;

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

  const allowedRepositories = parseAllowedRepositories(env);

  const installationId = env.GITHUB_APP_INSTALLATION_ID
    ? parsePositiveInteger(env.GITHUB_APP_INSTALLATION_ID, "GITHUB_APP_INSTALLATION_ID")
    : undefined;

  return {
    appId: parsePositiveInteger(env.GITHUB_APP_ID, "GITHUB_APP_ID"),
    privateKey: inlineKey ?? readFileSync(keyPath!, "utf8"),
    installationId,
    allowedRepositories,
  };
}

export function parseGitHubWebhookConfig(
  env: Environment = process.env,
): GitHubWebhookConfig {
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!webhookSecret || webhookSecret.length < 32) {
    throw new Error("GitHub webhook secret must be at least 32 characters");
  }
  return {
    webhookSecret,
    allowedRepositories: parseAllowedRepositories(env),
  };
}

function parseAllowedRepositories(env: Environment): Set<string> {
  const entries = (env.GITHUB_REPOSITORY_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (
    entries.length === 0 ||
    entries.some((entry) => !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(entry))
  ) {
    throw new Error("GitHub repository allowlist must contain exact owner/repo entries");
  }
  return new Set(entries);
}
