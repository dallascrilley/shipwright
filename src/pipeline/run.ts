import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AuthorizedIssue } from "../github/app-client.js";
import { parseIssueUrl } from "../github/issue-ref.js";
import { openOrReusePullRequest, pullRequestBody } from "../github/publisher.js";
import type { PullRequestResult } from "../github/types.js";
import { buildProgrammingPrompt } from "../agent/prompt.js";
import { PipelineError } from "./errors.js";
import { assertPublishableChange } from "./policy.js";
import { redactSecrets, truncateTail, type AgentExecution, type RunReceipt, writeReceipt } from "./receipt.js";

export interface WorkspacePort {
  clone(input: { owner: string; repo: string; defaultBranch: string; baseSha: string; branch: string; token: string }): Promise<void>;
  prepareForAgent(): Promise<void>;
  verify(command: string, timeoutMs: number): Promise<{ exitCode?: number | null; stdout?: string; stderr?: string }>;
  inspectChanges(): Promise<{ changedFiles: string[]; patch: string; patchBytes: number }>;
  quiesce(): Promise<void>;
  assertRunIdentity(baseSha: string, branch: string): Promise<void>;
  commit(message: string): Promise<string>;
  push(branch: string, token: string): Promise<void>;
  destroy(): Promise<void>;
}

export interface PipelineDependencies {
  execution: AgentExecution;
  authorize(ref: ReturnType<typeof parseIssueUrl>): Promise<AuthorizedIssue>;
  createWorkspace(): Promise<WorkspacePort>;
  runAgent(workspace: WorkspacePort, prompt: string, timeoutMs: number): Promise<string>;
  openPullRequest(authorized: AuthorizedIssue, input: Parameters<typeof openOrReusePullRequest>[1]): Promise<PullRequestResult>;
  writeReceipt(path: string, receipt: RunReceipt): Promise<void>;
  artifactRoot?: string;
  runId?: string;
  signal?: AbortSignal;
  onProgress?: (receipt: RunReceipt) => void | Promise<void>;
}

export interface RunRequest {
  issueUrl: string;
  verifyCommand: string;
  publish: boolean;
  timeoutMinutes: number;
}

export async function runShipwright(request: RunRequest, deps: PipelineDependencies): Promise<RunReceipt> {
  const runId = deps.runId ?? randomBytes(8).toString("hex");
  const receiptPath = join(deps.artifactRoot ?? ".artifacts/shipwright/receipts", runId, "receipt.json");
  const receipt: RunReceipt = {
    runId,
    phase: "intake",
    issueUrl: request.issueUrl,
    execution: deps.execution,
    changedFiles: [],
    verification: { command: request.verifyCommand, exitCode: null, passed: false },
  };
  const emitProgress = async () => {
    await deps.onProgress?.(structuredClone(receipt));
  };
  let workspace: WorkspacePort | undefined;
  try {
    await emitProgress();
    const issueRef = parseIssueUrl(request.issueUrl);
    const branch = `agent/issue-${issueRef.number}-${runId}`;
    receipt.branch = branch;
    const authorized = await deps.authorize(issueRef);
    deps.signal?.throwIfAborted();
    receipt.baseSha = authorized.issue.baseSha;
    receipt.phase = "workspace";
    await emitProgress();
    workspace = await deps.createWorkspace();
    await authorized.withInstallationToken((token) => workspace!.clone({
      owner: authorized.issue.owner,
      repo: authorized.issue.repo,
      defaultBranch: authorized.issue.defaultBranch,
      baseSha: authorized.issue.baseSha,
      branch,
      token,
    }));
    deps.signal?.throwIfAborted();
    await workspace.prepareForAgent();

    receipt.phase = "agent";
    await emitProgress();
    await abortable(deps.runAgent(workspace, buildProgrammingPrompt({
      title: authorized.issue.title,
      body: authorized.issue.body,
      issueUrl: authorized.issue.url,
      verifyCommand: request.verifyCommand,
    }), request.timeoutMinutes * 60_000), deps.signal);

    receipt.phase = "verify";
    await emitProgress();
    const verification = await abortable(
      workspace.verify(request.verifyCommand, request.timeoutMinutes * 60_000),
      deps.signal,
    );
    receipt.verification.exitCode = verification.exitCode ?? null;
    receipt.verification.passed = verification.exitCode === 0;
    if (verification.stdout) {
      receipt.verification.stdoutTail = truncateTail(verification.stdout);
    }
    if (verification.stderr) {
      receipt.verification.stderrTail = truncateTail(verification.stderr);
    }
    await emitProgress();
    if (!receipt.verification.passed) {
      throw new PipelineError("verify", "verification_failed", "independent verification failed");
    }

    deps.signal?.throwIfAborted();
    receipt.phase = "policy";
    await emitProgress();
    const changes = await workspace.inspectChanges();
    receipt.changedFiles = changes.changedFiles;
    assertPublishableChange(changes);
    await emitProgress();

    deps.signal?.throwIfAborted();
    if (request.publish) {
      receipt.phase = "publish";
      await emitProgress();
      const finalChanges = await workspace.inspectChanges();
      if (
        finalChanges.patch !== changes.patch ||
        finalChanges.changedFiles.join("\0") !== changes.changedFiles.join("\0")
      ) {
        throw new PipelineError("publish", "changes_moved", "repository changes moved after policy inspection");
      }
      await workspace.quiesce();
      await workspace.assertRunIdentity(authorized.issue.baseSha, branch);
      receipt.commitSha = await workspace.commit(`fix: ${authorized.issue.title} (#${authorized.issue.number})`);
      await authorized.withInstallationToken((token) => workspace!.push(branch, token));
      const pr = await deps.openPullRequest(authorized, {
        owner: authorized.issue.owner,
        repo: authorized.issue.repo,
        title: authorized.issue.title,
        issueNumber: authorized.issue.number,
        branch,
        baseBranch: authorized.issue.defaultBranch,
        commitSha: receipt.commitSha,
        body: pullRequestBody({
          issueNumber: authorized.issue.number,
          runId,
          verifyCommand: request.verifyCommand,
          changedFiles: changes.changedFiles,
          execution: deps.execution,
        }),
      });
      receipt.pullRequestUrl = pr.url;
      await emitProgress();
    }

    receipt.phase = "complete";
    await emitProgress();
    await deps.writeReceipt(receiptPath, receipt);
    return receipt;
  } catch (error) {
    const pipelineError =
      error instanceof PipelineError
        ? error
        : new PipelineError(
            receipt.phase,
            `${receipt.phase}_failed`,
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
    receipt.phase = pipelineError.phase;
    receipt.errorCode = pipelineError.code;
    receipt.errorMessage = redactSecrets(pipelineError.message);
    await emitProgress();
    await deps.writeReceipt(receiptPath, receipt);
    throw pipelineError;
  } finally {
    await workspace?.destroy();
  }
}

export const defaultReceiptWriter = writeReceipt;

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("run interrupted"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
