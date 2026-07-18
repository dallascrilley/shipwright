import type { PullRequestResult } from "./types.js";

export interface PullRequestApi {
  listPullRequests(input: { owner: string; repo: string; head: string; base: string }): Promise<Array<PullRequestResult & { headSha: string }>>;
  createPullRequest(input: { owner: string; repo: string; title: string; head: string; base: string; body: string; draft: false }): Promise<PullRequestResult>;
}

export function pullRequestBody(input: {
  issueNumber: number;
  runId: string;
  verifyCommand: string;
  changedFiles: string[];
}): string {
  const files = input.changedFiles.map((file) => `- \`${file}\``).join("\n");
  return [
    `Fixes #${input.issueNumber}`,
    "",
    "## Verification",
    "",
    `- Command: \`${input.verifyCommand}\``,
    "- Result: passed",
    `- Run: \`${input.runId}\``,
    "",
    "## Changed files",
    "",
    files,
  ].join("\n");
}

export async function openOrReusePullRequest(
  api: PullRequestApi,
  input: {
    owner: string;
    repo: string;
    title: string;
    issueNumber: number;
    branch: string;
    baseBranch: string;
    commitSha: string;
    body: string;
  },
): Promise<PullRequestResult> {
  const existing = await api.listPullRequests({
    owner: input.owner,
    repo: input.repo,
    head: `${input.owner}:${input.branch}`,
    base: input.baseBranch,
  });
  if (existing.length > 0) {
    if (existing[0]!.headSha !== input.commitSha) {
      throw new Error("existing pull request head points to a different commit");
    }
    return existing[0]!;
  }
  return api.createPullRequest({
    owner: input.owner,
    repo: input.repo,
    title: input.title,
    head: input.branch,
    base: input.baseBranch,
    body: input.body,
    draft: false,
  });
}
