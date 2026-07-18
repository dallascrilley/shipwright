import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import type { GitHubConfig } from "../config/github.js";
import type { IssueContext, IssueRef } from "./types.js";
import type { PullRequestApi } from "./publisher.js";

const INSTALLATION_PERMISSIONS = {
  contents: "write",
  issues: "read",
  pull_requests: "write",
  metadata: "read",
} as const;

export interface RepositoryClient {
  getRepository(): Promise<{ id: number; owner: string; name: string; defaultBranch: string }>;
  getIssue(number: number): Promise<{ title: string; body: string; isPullRequest: boolean }>;
  getBranchSha(branch: string): Promise<string>;
}

export interface RepositorySession {
  client: RepositoryClient & PullRequestApi;
  withInstallationToken<T>(action: (token: string) => Promise<T>): Promise<T>;
}

export interface GitHubTransport {
  resolveInstallation(ref: IssueRef): Promise<number>;
  createRepositoryClient(input: {
    installationId: number;
    owner: string;
    repo: string;
    permissions: typeof INSTALLATION_PERMISSIONS;
  }): Promise<RepositorySession>;
}

export interface AuthorizedIssue {
  issue: IssueContext;
  repositoryClient: RepositoryClient & PullRequestApi;
  withInstallationToken<T>(action: (token: string) => Promise<T>): Promise<T>;
}

export async function authorizeIssue(
  ref: IssueRef,
  config: GitHubConfig,
  transport: GitHubTransport,
): Promise<AuthorizedIssue> {
  if (!config.allowedRepositories.has(`${ref.owner}/${ref.repo}`.toLowerCase())) {
    throw new Error("repository is not in the GitHub repository allowlist");
  }
  const installationId = config.installationId ?? (await transport.resolveInstallation(ref));
  const repositorySession = await transport.createRepositoryClient({
    installationId,
    owner: ref.owner,
    repo: ref.repo,
    permissions: INSTALLATION_PERMISSIONS,
  });
  const repositoryClient = repositorySession.client;
  const repository = await repositoryClient.getRepository();
  if (!config.allowedRepositories.has(`${repository.owner}/${repository.name}`.toLowerCase())) {
    throw new Error("canonical repository is not in the GitHub repository allowlist");
  }
  const issue = await repositoryClient.getIssue(ref.number);
  if (issue.isPullRequest) throw new Error("the URL refers to a pull request, not an issue");
  const baseSha = await repositoryClient.getBranchSha(repository.defaultBranch);
  return {
    issue: {
      ...ref,
      owner: repository.owner,
      repo: repository.name,
      title: issue.title,
      body: issue.body,
      defaultBranch: repository.defaultBranch,
      baseSha,
      installationId,
    },
    repositoryClient,
    withInstallationToken: repositorySession.withInstallationToken,
  };
}

export function createOctokitTransport(config: GitHubConfig): GitHubTransport {
  const app = new App({ appId: config.appId, privateKey: config.privateKey, Octokit });
  return {
    async resolveInstallation(ref) {
      const response = await app.octokit.request("GET /repos/{owner}/{repo}/installation", {
        owner: ref.owner,
        repo: ref.repo,
      });
      return response.data.id;
    },
    async createRepositoryClient(input) {
      const auth = await app.octokit.auth({
        type: "installation",
        installationId: input.installationId,
        repositoryNames: [input.repo],
        permissions: input.permissions,
      });
      if (typeof auth !== "object" || auth === null || !("token" in auth) || typeof auth.token !== "string") {
        throw new Error("GitHub App did not return an installation token");
      }
      const token = auth.token;
      const octokit = new Octokit({ auth: token });
      const client: RepositoryClient & PullRequestApi = {
        async getRepository() {
          const { data } = await octokit.repos.get({ owner: input.owner, repo: input.repo });
          return { id: data.id, owner: data.owner.login, name: data.name, defaultBranch: data.default_branch };
        },
        async getIssue(number) {
          const { data } = await octokit.issues.get({ owner: input.owner, repo: input.repo, issue_number: number });
          return { title: data.title, body: data.body ?? "", isPullRequest: "pull_request" in data };
        },
        async getBranchSha(branch) {
          const { data } = await octokit.git.getRef({ owner: input.owner, repo: input.repo, ref: `heads/${branch}` });
          return data.object.sha;
        },
        async listPullRequests(query) {
          const { data } = await octokit.pulls.list({
            owner: query.owner,
            repo: query.repo,
            head: query.head,
            base: query.base,
            state: "open",
          });
          return data.map((pull) => ({ number: pull.number, url: pull.html_url, headSha: pull.head.sha }));
        },
        async createPullRequest(query) {
          const { data } = await octokit.pulls.create({
            owner: query.owner,
            repo: query.repo,
            title: query.title,
            head: query.head,
            base: query.base,
            body: query.body,
            draft: query.draft,
          });
          return { number: data.number, url: data.html_url };
        },
      };
      return {
        client,
        async withInstallationToken(action) {
          return action(token);
        },
      };
    },
  };
}
