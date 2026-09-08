import type { PullRequestResult } from "./types.js";
import type { AgentExecution } from "../pipeline/receipt.js";

export interface PullRequestApi {
  listPullRequests(input: { owner: string; repo: string; head: string; base: string }): Promise<Array<PullRequestResult & { headSha: string; title?: string; body?: string }>>;
  createPullRequest(input: { owner: string; repo: string; title: string; head: string; base: string; body: string; draft: false }): Promise<PullRequestResult>;
}

export function pullRequestBody(input: {
  issueNumber: number;
  runId: string;
  verifyCommand: string;
  changedFiles: string[];
  execution: AgentExecution;
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
    "## Agent execution",
    "",
    `- Runtime: \`${input.execution.runtime}\``,
    `- Software: \`${input.execution.software}\``,
    `- Provider: \`${input.execution.provider}\``,
    `- Model: \`${input.execution.model}\``,
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

/** Create or reconcile a follow-up PR without switching the selected base/head. */
export async function openOrReuseFollowUpPullRequest(
  api: PullRequestApi,
  input: {
    owner: string;
    repo: string;
    title: string;
    branch: string;
    baseBranch: string;
    commitSha: string;
    candidateId: string;
    candidateDigest: string;
    body: string;
  },
): Promise<PullRequestResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.candidateId)) {
    throw new Error("follow-up candidate id is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(input.candidateDigest)) {
    throw new Error("follow-up candidate digest is invalid");
  }
  const marker = `Shipwright-Candidate: ${input.candidateId} Digest: ${input.candidateDigest}`;
  const existing = await api.listPullRequests({
    owner: input.owner,
    repo: input.repo,
    head: `${input.owner}:${input.branch}`,
    base: input.baseBranch,
  });
  const marked = existing.find((pull) => pull.title?.includes(marker) || pull.body?.includes(marker));
  if (marked) {
    if (marked.headSha !== input.commitSha) throw new Error("follow-up PR head does not match candidate commit");
    return marked;
  }
  if (existing.length > 0) {
    throw new Error("existing follow-up PR on candidate branch is not bound to this candidate");
  }
  return api.createPullRequest({
    owner: input.owner,
    repo: input.repo,
    title: `${input.title} [${marker}]`,
    head: input.branch,
    base: input.baseBranch,
    body: `${input.body}\n\n${marker}`,
    draft: false,
  });
}
