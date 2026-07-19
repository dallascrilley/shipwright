import { createAndRunPiAgent } from "../agent/runner.js";
import { parseGitHubConfig } from "../config/github.js";
import { resolveProvider } from "../config/provider.js";
import { authorizeIssue, createOctokitTransport } from "../github/app-client.js";
import { openOrReusePullRequest } from "../github/publisher.js";
import type { RunReceipt } from "../pipeline/receipt.js";
import { defaultReceiptWriter, type PipelineDependencies } from "../pipeline/run.js";
import { SandboxWorkspace } from "../sandbox/runtime.js";

export interface PipelineDependencyOptions {
  signal?: AbortSignal;
  runId?: string;
  onProgress?: (receipt: RunReceipt) => void | Promise<void>;
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
