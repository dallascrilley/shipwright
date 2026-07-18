import { parseArgs } from "./args.js";
import { parseGitHubConfig } from "../config/github.js";
import { resolveProvider } from "../config/provider.js";
import { authorizeIssue, createOctokitTransport } from "../github/app-client.js";
import { openOrReusePullRequest } from "../github/publisher.js";
import { createAndRunPiAgent } from "../agent/runner.js";
import { runProgrammingAgent, defaultReceiptWriter } from "../pipeline/run.js";
import { redactSecrets } from "../pipeline/receipt.js";
import { SandboxWorkspace } from "../sandbox/runtime.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const githubConfig = parseGitHubConfig();
  const provider = resolveProvider();
  const transport = createOctokitTransport(githubConfig);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("run interrupted by signal"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const receipt = await runProgrammingAgent(args, {
      authorize: (ref) => authorizeIssue(ref, githubConfig, transport),
      createWorkspace: () => SandboxWorkspace.start(),
      runAgent: (workspace, prompt, timeoutMs) =>
        createAndRunPiAgent(workspace as SandboxWorkspace, provider, prompt, timeoutMs),
      openPullRequest: (authorized, input) => openOrReusePullRequest(authorized.repositoryClient, input),
      writeReceipt: defaultReceiptWriter,
      signal: controller.signal,
    });
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

export async function runMain(argv = process.argv.slice(2)): Promise<number> {
  try {
    await main(argv);
    return 0;
  } catch (error) {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}
