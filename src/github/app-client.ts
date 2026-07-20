import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import type { GitHubConfig } from "../config/github.js";
import type {
  IssueContext,
  IssueRef,
  PullRequestContext,
  PullRequestRef,
  PullRequestReview,
  ReviewThread,
} from "./types.js";
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

export interface ReviewApi {
  getPullRequest(number: number): Promise<{
    title: string;
    body: string;
    state: string;
    draft: boolean;
    baseBranch: string;
    baseSha: string;
    headBranch: string;
    headSha: string;
    headOwner: string;
    headRepo: string;
  }>;
  listReviewThreads(number: number): Promise<ReviewThread[]>;
  listReviews(number: number): Promise<PullRequestReview[]>;
  replyToReviewThread(threadId: string, body: string): Promise<{ url: string }>;
  resolveReviewThread(threadId: string): Promise<{ isResolved: boolean }>;
  addPullRequestComment(number: number, body: string): Promise<{ url: string }>;
}

export interface RepositorySession {
  client: RepositoryClient & PullRequestApi & ReviewApi;
  withInstallationToken<T>(action: (token: string) => Promise<T>): Promise<T>;
}

export interface GitHubTransport {
  resolveInstallation(ref: IssueRef | PullRequestRef): Promise<number>;
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

export interface AuthorizedPullRequest {
  pullRequest: PullRequestContext;
  reviewThreads: ReviewThread[];
  reviews: PullRequestReview[];
  repositoryClient: RepositoryClient & PullRequestApi & ReviewApi;
  withInstallationToken<T>(action: (token: string) => Promise<T>): Promise<T>;
}

export async function authorizePullRequest(
  ref: PullRequestRef,
  config: GitHubConfig,
  transport: GitHubTransport,
): Promise<AuthorizedPullRequest> {
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
  const canonicalName = `${repository.owner}/${repository.name}`.toLowerCase();
  if (!config.allowedRepositories.has(canonicalName)) {
    throw new Error("canonical repository is not in the GitHub repository allowlist");
  }
  const pullRequest = await repositoryClient.getPullRequest(ref.number);
  if (pullRequest.state !== "open") throw new Error("pull request must be open");
  if (`${pullRequest.headOwner}/${pullRequest.headRepo}`.toLowerCase() !== canonicalName) {
    throw new Error("fork pull request heads are not supported");
  }
  const [reviewThreads, reviews] = await Promise.all([
    repositoryClient.listReviewThreads(ref.number),
    repositoryClient.listReviews(ref.number),
  ]);
  return {
    pullRequest: {
      ...ref,
      owner: repository.owner,
      repo: repository.name,
      title: pullRequest.title,
      body: pullRequest.body,
      baseBranch: pullRequest.baseBranch,
      baseSha: pullRequest.baseSha,
      headBranch: pullRequest.headBranch,
      headSha: pullRequest.headSha,
      installationId,
    },
    reviewThreads,
    reviews,
    repositoryClient,
    withInstallationToken: repositorySession.withInstallationToken,
  };
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
      const client: RepositoryClient & PullRequestApi & ReviewApi = {
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
        async getPullRequest(number) {
          const { data } = await octokit.pulls.get({ owner: input.owner, repo: input.repo, pull_number: number });
          if (!data.head.repo) throw new Error("pull request head repository is unavailable");
          return {
            title: data.title,
            body: data.body ?? "",
            state: data.state,
            draft: data.draft ?? false,
            baseBranch: data.base.ref,
            baseSha: data.base.sha,
            headBranch: data.head.ref,
            headSha: data.head.sha,
            headOwner: data.head.repo.owner.login,
            headRepo: data.head.repo.name,
          };
        },
        async listReviewThreads(number) {
          const response = await octokit.graphql<{
            repository: { pullRequest: { reviewThreads: { nodes: Array<{
              id: string;
              isResolved: boolean;
              isOutdated: boolean;
              path: string;
              line: number | null;
              comments: { nodes: Array<{
                id: string;
                body: string;
                url: string;
                author: { login: string } | null;
              }> };
            }> } } | null };
          }>(`query($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $number) {
                reviewThreads(first: 100) {
                  nodes {
                    id isResolved isOutdated path line
                    comments(first: 100) { nodes { id body url author { login } } }
                  }
                }
              }
            }
          }`, { owner: input.owner, repo: input.repo, number });
          const pullRequest = response.repository.pullRequest;
          if (!pullRequest) throw new Error("pull request was not found");
          return pullRequest.reviewThreads.nodes.map((thread) => ({
            ...thread,
            comments: thread.comments.nodes.map((comment) => ({
              id: comment.id,
              body: comment.body,
              url: comment.url,
              author: comment.author?.login ?? "unknown",
            })),
          }));
        },
        async listReviews(number) {
          const { data } = await octokit.pulls.listReviews({
            owner: input.owner,
            repo: input.repo,
            pull_number: number,
            per_page: 100,
          });
          return data.map((review) => ({
            id: String(review.node_id ?? review.id),
            state: review.state,
            body: review.body ?? "",
            author: review.user?.login ?? "unknown",
          }));
        },
        async replyToReviewThread(threadId, body) {
          const response = await octokit.graphql<{
            addPullRequestReviewThreadReply: { comment: { url: string } };
          }>(`mutation($threadId: ID!, $body: String!) {
            addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
              comment { url }
            }
          }`, { threadId, body });
          return response.addPullRequestReviewThreadReply.comment;
        },
        async resolveReviewThread(threadId) {
          const response = await octokit.graphql<{
            resolveReviewThread: { thread: { isResolved: boolean } };
          }>(`mutation($threadId: ID!) {
            resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
          }`, { threadId });
          return response.resolveReviewThread.thread;
        },
        async addPullRequestComment(number, body) {
          const { data } = await octokit.issues.createComment({
            owner: input.owner,
            repo: input.repo,
            issue_number: number,
            body,
          });
          return { url: data.html_url };
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
