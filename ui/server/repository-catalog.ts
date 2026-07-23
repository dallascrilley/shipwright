import {
  isRepositoryAllowed,
  parseGitHubConfig,
  type GitHubConfig,
} from "../../src/config/github.js";
import {
  createOctokitTransport,
  type GitHubAccessibleRepository,
  type GitHubTransport,
} from "../../src/github/app-client.js";
import {
  agentRepositoryCatalogResultSchema,
  normalizeRepositoryIdentifier,
  type AgentRepositoryCatalogResult,
  type AgentRepositoryOption,
} from "../shared/repository-catalog";
import { isOperatorDemoMode } from "./operator-runs";

const DEMO_REPOSITORIES: AgentRepositoryOption[] = [
  {
    repository: "dallascrilley/shipwright",
    owner: "dallascrilley",
    name: "shipwright",
    defaultBranch: "main",
    visibility: "private",
    archived: false,
    selectable: true,
  },
  {
    repository: "dallascrilleymartech/example",
    owner: "dallascrilleymartech",
    name: "example",
    defaultBranch: "main",
    visibility: "private",
    archived: false,
    selectable: true,
  },
];

export interface AgentRepositoryCatalogDependencies {
  isDemoMode?: () => boolean;
  loadGitHubConfig?: () => GitHubConfig | null;
  createTransport?: (config: GitHubConfig) => GitHubTransport;
  demoRepositories?: readonly AgentRepositoryOption[];
}

export class AgentRepositoryCatalog {
  readonly #isDemoMode: () => boolean;
  readonly #loadGitHubConfig: () => GitHubConfig | null;
  readonly #createTransport: (config: GitHubConfig) => GitHubTransport;
  readonly #demoRepositories: readonly AgentRepositoryOption[];

  constructor(dependencies: AgentRepositoryCatalogDependencies = {}) {
    this.#isDemoMode = dependencies.isDemoMode ?? isOperatorDemoMode;
    this.#loadGitHubConfig =
      dependencies.loadGitHubConfig ??
      (() => {
        try {
          return parseGitHubConfig();
        } catch {
          return null;
        }
      });
    this.#createTransport =
      dependencies.createTransport ?? createOctokitTransport;
    this.#demoRepositories = dependencies.demoRepositories ?? DEMO_REPOSITORIES;
  }

  async list(): Promise<AgentRepositoryCatalogResult> {
    if (this.#isDemoMode()) {
      return agentRepositoryCatalogResultSchema.parse({
        ok: true,
        repositories: [...this.#demoRepositories],
      });
    }

    let config: GitHubConfig | null;
    try {
      config = this.#loadGitHubConfig();
    } catch {
      config = null;
    }
    if (!config) {
      return catalogError(
        "not_configured",
        "GitHub App repository access is not configured on this host.",
      );
    }

    try {
      const repositories =
        await this.#createTransport(config).listAccessibleRepositories();
      const options = buildRepositoryOptions(repositories, config);
      if (options.length === 0) {
        return catalogError(
          "no_repositories",
          "No repositories are available to both the GitHub App and repository allowlist.",
        );
      }
      return agentRepositoryCatalogResultSchema.parse({
        ok: true,
        repositories: options,
      });
    } catch {
      return catalogError(
        "github_unavailable",
        "GitHub repositories could not be loaded. Check the GitHub App installation and try again.",
      );
    }
  }

  async assertSelectable(repository: string): Promise<AgentRepositoryOption> {
    const canonical = normalizeRepositoryIdentifier(repository);
    if (!canonical) {
      throw new Error("Repository scope must use owner/repository format.");
    }
    const result = await this.list();
    if (!result.ok) throw new Error(result.message);
    const option = result.repositories.find(
      (candidate) => candidate.repository === canonical,
    );
    if (!option) {
      throw new Error(
        `Repository ${canonical} is not accessible to the configured GitHub App and allowlist.`,
      );
    }
    if (!option.selectable || option.archived) {
      throw new Error(
        `Repository ${canonical} is archived and cannot be selected.`,
      );
    }
    return option;
  }
}

function buildRepositoryOptions(
  repositories: readonly GitHubAccessibleRepository[],
  config: GitHubConfig,
): AgentRepositoryOption[] {
  const byRepository = new Map<string, AgentRepositoryOption>();
  for (const repository of repositories) {
    const canonical = normalizeRepositoryIdentifier(repository.fullName);
    if (!canonical || !isRepositoryAllowed(config, canonical)) continue;
    const [owner, name] = canonical.split("/");
    if (!owner || !name || byRepository.has(canonical)) continue;
    byRepository.set(canonical, {
      repository: canonical,
      owner,
      name,
      defaultBranch: repository.defaultBranch,
      visibility: repository.visibility,
      archived: repository.archived,
      selectable: !repository.archived,
    });
  }
  return [...byRepository.values()].sort((left, right) =>
    left.repository.localeCompare(right.repository),
  );
}

function catalogError(
  code: "not_configured" | "github_unavailable" | "no_repositories",
  message: string,
): AgentRepositoryCatalogResult {
  return agentRepositoryCatalogResultSchema.parse({ ok: false, code, message });
}

let repositoryCatalog: AgentRepositoryCatalog | undefined;

export function getAgentRepositoryCatalog(): AgentRepositoryCatalog {
  repositoryCatalog ??= new AgentRepositoryCatalog();
  return repositoryCatalog;
}
