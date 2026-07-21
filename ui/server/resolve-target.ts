import { parseGitHubConfig, type GitHubConfig } from "../../src/config/github.js";
import {
  authorizeIssue,
  authorizePullRequest,
  createOctokitTransport,
  type GitHubTransport,
} from "../../src/github/app-client.js";
import {
  parseOperatorTarget,
  type ResolveTargetResult,
} from "../shared/operator-run";

const DEMO_PIN_SHA = "0000000000000000000000000000000000000000";

export interface ResolveTargetDeps {
  isDemoMode: () => boolean;
  loadGitHubConfig: () => GitHubConfig | null;
  createTransport: (config: GitHubConfig) => GitHubTransport;
  authorizeIssue: typeof authorizeIssue;
  authorizePullRequest: typeof authorizePullRequest;
}

function defaultDeps(): ResolveTargetDeps {
  return {
    // guard:allow-env-credential — deploy-level non-secret demo-mode flag.
    isDemoMode: () => process.env.SHIPWRIGHT_UI_DEMO === "1",
    loadGitHubConfig: () => {
      try {
        return parseGitHubConfig();
      } catch {
        return null;
      }
    },
    createTransport: createOctokitTransport,
    authorizeIssue,
    authorizePullRequest,
  };
}

function parseDenied(reason: string): ResolveTargetResult {
  return {
    kind: "issue",
    owner: "",
    repo: "",
    number: 0,
    url: "",
    allowed: false,
    denyReason: reason,
  };
}

function fromParsed(
  parsed: NonNullable<ReturnType<typeof parseOperatorTarget>>,
  extra: Partial<ResolveTargetResult> = {},
): ResolveTargetResult {
  return {
    kind: parsed.kind,
    owner: parsed.owner,
    repo: parsed.repo,
    number: parsed.number,
    url: parsed.url,
    allowed: true,
    ...extra,
  };
}

export interface ResolveTargetOptions {
  /** When false, PR preflight skips review-thread listing (run start path). */
  includeReviewThreads?: boolean;
}

/**
 * Parse-first target preflight. Live mode fetches title/head only when GitHub App
 * is configured; otherwise returns parse-only metadata.
 */
export async function resolveTarget(
  url: string,
  deps: Partial<ResolveTargetDeps> = {},
  options: ResolveTargetOptions = {},
): Promise<ResolveTargetResult> {
  const includeReviewThreads = options.includeReviewThreads ?? true;
  const resolved = { ...defaultDeps(), ...deps };
  const parsed = parseOperatorTarget(url.trim());
  if (!parsed) {
    return parseDenied("Enter a canonical GitHub issue or pull request URL.");
  }

  if (resolved.isDemoMode()) {
    return fromParsed(parsed, {
      title: `Demo ${parsed.kind} #${parsed.number}`,
      pinned: { headSha: DEMO_PIN_SHA },
    });
  }

  const config = resolved.loadGitHubConfig();
  if (!config) {
    return fromParsed(parsed);
  }

  try {
    const transport = resolved.createTransport(config);
    if (parsed.kind === "issue") {
      const authorized = await resolved.authorizeIssue(
        {
          owner: parsed.owner,
          repo: parsed.repo,
          number: parsed.number,
          url: parsed.url,
        },
        config,
        transport,
      );
      return fromParsed(parsed, {
        title: authorized.issue.title,
        pinned: { headSha: authorized.issue.baseSha },
      });
    }

    if (!includeReviewThreads) {
      return resolvePullRequestHead(parsed, config, transport);
    }

    const authorized = await resolved.authorizePullRequest(
      {
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        url: parsed.url,
      },
      config,
      transport,
    );
    const openThreadCount = authorized.reviewThreads.filter(
      (thread) => !thread.isResolved,
    ).length;
    return fromParsed(parsed, {
      title: authorized.pullRequest.title,
      pinned: {
        headSha: authorized.pullRequest.headSha,
        openThreadCount,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Target could not be authorized.";
    return fromParsed(parsed, { allowed: false, denyReason: message });
  }
}

async function resolvePullRequestHead(
  parsed: NonNullable<ReturnType<typeof parseOperatorTarget>>,
  config: GitHubConfig,
  transport: GitHubTransport,
): Promise<ResolveTargetResult> {
  const repoKey = `${parsed.owner}/${parsed.repo}`.toLowerCase();
  if (!config.allowedRepositories.has(repoKey)) {
    return fromParsed(parsed, {
      allowed: false,
      denyReason: "repository is not in the GitHub repository allowlist",
    });
  }

  const installationId =
    config.installationId ??
    (await transport.resolveInstallation({
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      url: parsed.url,
    }));
  const session = await transport.createRepositoryClient({
    installationId,
    owner: parsed.owner,
    repo: parsed.repo,
    permissions: {
      contents: "write",
      issues: "read",
      pull_requests: "write",
      metadata: "read",
    },
  });
  const repository = await session.client.getRepository();
  const canonicalName = `${repository.owner}/${repository.name}`.toLowerCase();
  if (!config.allowedRepositories.has(canonicalName)) {
    return fromParsed(parsed, {
      allowed: false,
      denyReason: "canonical repository is not in the GitHub repository allowlist",
    });
  }

  const pullRequest = await session.client.getPullRequest(parsed.number);
  if (pullRequest.state !== "open") {
    return fromParsed(parsed, {
      allowed: false,
      denyReason: "pull request must be open",
    });
  }
  if (
    `${pullRequest.headOwner}/${pullRequest.headRepo}`.toLowerCase() !==
    canonicalName
  ) {
    return fromParsed(parsed, {
      allowed: false,
      denyReason: "fork pull request heads are not supported",
    });
  }

  return fromParsed(parsed, {
    title: pullRequest.title,
    pinned: { headSha: pullRequest.headSha },
  });
}
