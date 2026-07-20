import { createAndRunPiAgent } from "../agent/runner.js";
import { parseGitHubConfig } from "../config/github.js";
import { resolveProvider } from "../config/provider.js";
import { authorizeIssue, createOctokitTransport } from "../github/app-client.js";
import { authorizePullRequest } from "../github/app-client.js";
import { openOrReusePullRequest } from "../github/publisher.js";
import type { RunReceipt } from "../pipeline/receipt.js";
import { defaultReceiptWriter, type PipelineDependencies } from "../pipeline/run.js";
import { defaultReviewReceiptWriter, type ReviewPipelineDependencies } from "../pipeline/review-run.js";
import type { ReviewRunReceipt } from "../pipeline/review-receipt.js";
import { SandboxWorkspace } from "../sandbox/runtime.js";

export interface PipelineDependencyOptions {
  signal?: AbortSignal;
  runId?: string;
  onProgress?: (receipt: RunReceipt) => void | Promise<void>;
}

export interface ReviewPipelineDependencyOptions {
  signal?: AbortSignal;
  runId?: string;
  onProgress?: (receipt: ReviewRunReceipt) => void | Promise<void>;
}

export function createReviewPipelineDependencies(
  skillPath: string,
  options: ReviewPipelineDependencyOptions = {},
): ReviewPipelineDependencies {
  const githubConfig = parseGitHubConfig();
  const provider = resolveProvider();
  const transport = createOctokitTransport(githubConfig);
  const content = readFileSync(skillPath, "utf8");
  if (!/^---[\s\S]*?^name:\s*["']?fix-review-findings["']?\s*$/m.test(content)) {
    throw new Error("--skill must point to the fix-review-findings SKILL.md");
  }
  const skill = {
    name: "fix-review-findings" as const,
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  return {
    execution: Object.freeze({
      runtime: "agentos",
      software: "pi",
      provider: provider.name,
      model: provider.model,
    }),
    skill,
    authorize: (ref) => authorizePullRequest(ref, githubConfig, transport),
    createWorkspace: () => SandboxWorkspace.start(),
    runAgent: (workspace, prompt, timeoutMs, skills) => createAndRunPiAgent(
      workspace as SandboxWorkspace,
      provider,
      prompt,
      timeoutMs,
      skills,
    ),
    writeReceipt: defaultReviewReceiptWriter,
    ...options,
  };
}

export function createPipelineDependencies(
  options: PipelineDependencyOptions = {},
): PipelineDependencies {
  const githubConfig = parseGitHubConfig();
  const provider = resolveProvider();
  const transport = createOctokitTransport(githubConfig);

  return {
    execution: Object.freeze({
      runtime: "agentos",
      software: "pi",
      provider: provider.name,
      model: provider.model,
    }),
    authorize: (ref) => authorizeIssue(ref, githubConfig, transport),
    createWorkspace: () => SandboxWorkspace.start(),
    runAgent: (workspace, prompt, timeoutMs) =>
      createAndRunPiAgent(
        workspace as SandboxWorkspace,
        provider,
        prompt,
        timeoutMs,
      ),
    openPullRequest: (authorized, input) =>
      openOrReusePullRequest(authorized.repositoryClient, input),
    writeReceipt: defaultReceiptWriter,
    ...options,
  };
}
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
