import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  PI_AGENT_OUTPUT_ERROR_CODE,
  PiAgentOutputError,
  type AgentSkillProjection,
} from "../agent/runner.js";
import { buildReviewPrompt, REVIEW_OUTCOME_PATH } from "../agent/review-prompt.js";
import {
  isProviderCapacityError,
  PROVIDER_CAPACITY_ERROR_CODE,
} from "../config/provider.js";
import type { AuthorizedPullRequest } from "../github/app-client.js";
import { parsePullRequestUrl } from "../github/pull-request-ref.js";
import { findMarkedReply, reviewRunMarker, unresolvedCurrentThreads } from "../github/review-client.js";
import type { PullRequestRef, ReviewThread } from "../github/types.js";
import type { ChangeInspection } from "../sandbox/runtime.js";
import { assertPublishableChange } from "./policy.js";
import { parseReviewOutcomes, type ReviewOutcome } from "./review-outcomes.js";
import { redactSecrets, truncateTail, type AgentExecution } from "./receipt.js";
import { type ReviewRunPhase, type ReviewRunReceipt, writeReviewReceipt } from "./review-receipt.js";

/**
 * Coding-provider quota/usage-limit exhaustion (e.g. an HTTP 403 "usage limit"
 * from Kimi) is an operator billing condition, not an agent or code defect. We
 * classify it distinctly so operators and automation can tell "the configured
 * provider chain is out of capacity" apart from a genuine agent failure.
 */
export const PROVIDER_QUOTA_ERROR_CODE = PROVIDER_CAPACITY_ERROR_CODE;
export const REVIEW_OUTCOME_MISSING_ERROR_CODE = "agent_outcome_missing";

class ReviewOutcomeMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewOutcomeMissingError";
  }
}

export function isProviderQuotaError(message: string): boolean {
  return isProviderCapacityError(message);
}

export interface ReviewWorkspacePort {
  clonePullRequest(input: { owner: string; repo: string; headBranch: string; headSha: string; token: string }): Promise<void>;
  prepareForAgent(): Promise<void>;
  prepareReviewArtifact(path: string): Promise<void>;
  readAndRemoveArtifact(path: string): Promise<string>;
  verify(command: string, timeoutMs: number): Promise<{ exitCode?: number | null; stdout?: string; stderr?: string }>;
  inspectChanges(): Promise<ChangeInspection>;
  quiesce(): Promise<void>;
  assertRunIdentity(headSha: string, branch: string): Promise<void>;
  commit(message: string): Promise<string>;
  push(branch: string, token: string): Promise<void>;
  destroy(): Promise<void>;
}

export interface ReviewPipelineDependencies {
  execution: AgentExecution;
  skill: AgentSkillProjection & { name: "fix-review-findings"; sha256: string };
  authorize(ref: PullRequestRef): Promise<AuthorizedPullRequest>;
  createWorkspace(): Promise<ReviewWorkspacePort>;
  runAgent(workspace: ReviewWorkspacePort, prompt: string, timeoutMs: number, skills: AgentSkillProjection[]): Promise<string>;
  writeReceipt(path: string, receipt: ReviewRunReceipt): Promise<void>;
  artifactRoot?: string;
  runId?: string;
  signal?: AbortSignal;
  onProgress?: (receipt: ReviewRunReceipt) => void | Promise<void>;
}

export interface ReviewRunRequest {
  pullRequestUrl: string;
  verifyCommand: string;
  publish: boolean;
  timeoutMinutes: number;
}

export async function runReviewAgent(
  request: ReviewRunRequest,
  deps: ReviewPipelineDependencies,
): Promise<ReviewRunReceipt> {
  const runId = deps.runId ?? randomBytes(8).toString("hex");
  const receiptPath = join(
    deps.artifactRoot ?? ".artifacts/shipwright/review-receipts",
    runId,
    "receipt.json",
  );
  const receipt: ReviewRunReceipt = {
    runId,
    phase: "intake",
    pullRequestUrl: request.pullRequestUrl,
    execution: deps.execution,
    skill: { name: deps.skill.name, sha256: deps.skill.sha256 },
    changedFiles: [],
    verification: { command: request.verifyCommand, exitCode: null, passed: false },
    threadResults: [],
    remainingOpenThreadIds: [],
  };
  const emitProgress = async () => deps.onProgress?.(structuredClone(receipt));
  let workspace: ReviewWorkspacePort | undefined;
  let phase: ReviewRunPhase = "intake";
  try {
    await emitProgress();
    const ref = parsePullRequestUrl(request.pullRequestUrl);
    const authorized = await deps.authorize(ref);
    deps.signal?.throwIfAborted();
    const threads = unresolvedCurrentThreads(authorized.reviewThreads);
    if (threads.length === 0) throw new Error("pull request has no unresolved current review threads");
    receipt.authorizedHeadSha = authorized.pullRequest.headSha;
    receipt.headBranch = authorized.pullRequest.headBranch;

    phase = receipt.phase = "workspace";
    await emitProgress();
    workspace = await deps.createWorkspace();
    await authorized.withInstallationToken((token) => workspace!.clonePullRequest({
      owner: authorized.pullRequest.owner,
      repo: authorized.pullRequest.repo,
      headBranch: authorized.pullRequest.headBranch,
      headSha: authorized.pullRequest.headSha,
      token,
    }));
    deps.signal?.throwIfAborted();
    await workspace.prepareForAgent();
    await workspace.prepareReviewArtifact(REVIEW_OUTCOME_PATH);

    phase = receipt.phase = "agent";
    await emitProgress();
    const agentResponse = await abortable(deps.runAgent(
      workspace,
      buildReviewPrompt({
        pullRequest: authorized.pullRequest,
        threads,
        reviews: authorized.reviews,
        verifyCommand: request.verifyCommand,
      }),
      request.timeoutMinutes * 60_000,
      [{ name: deps.skill.name, content: deps.skill.content }],
    ), deps.signal);
    let serializedOutcomes: string;
    try {
      serializedOutcomes = await workspace.readAndRemoveArtifact(REVIEW_OUTCOME_PATH);
    } catch (readError) {
      // The agent finished without writing the required outcome artifact. Surface its own
      // response (redacted) so the real cause is legible instead of a bare `cat` error.
      const original = readError instanceof Error ? readError.message : String(readError);
      const detail = redactSecrets(truncateTail(agentResponse)).trim() || "(no agent output)";
      markLastAgentAttemptFailed(deps.execution);
      throw new ReviewOutcomeMissingError(
        `review agent finished without writing ${REVIEW_OUTCOME_PATH} (${original}); agent response: ${detail}`,
      );
    }
    const expectedThreadIds = threads.map((thread) => thread.id);
    parseReviewOutcomes(serializedOutcomes, expectedThreadIds);

    phase = receipt.phase = "verify";
    await emitProgress();
    const verification = await abortable(
      workspace.verify(request.verifyCommand, request.timeoutMinutes * 60_000),
      deps.signal,
    );
    receipt.verification.exitCode = verification.exitCode ?? null;
    receipt.verification.passed = verification.exitCode === 0;
    if (verification.stdout) {
      receipt.verification.stdoutTail = redactSecrets(truncateTail(verification.stdout));
    }
    if (verification.stderr) {
      receipt.verification.stderrTail = redactSecrets(truncateTail(verification.stderr));
    }
    await emitProgress();
    if (!receipt.verification.passed) throw new Error("independent verification failed");

    deps.signal?.throwIfAborted();
    phase = receipt.phase = "policy";
    await emitProgress();
    const changes = await workspace.inspectChanges();
    receipt.changedFiles = changes.changedFiles;
    if (changes.changedFiles.length > 0) assertPublishableChange(changes);
    const outcomes = parseReviewOutcomes(serializedOutcomes, expectedThreadIds, changes.changedFiles);
    await emitProgress();

    if (!request.publish) {
      receipt.remainingOpenThreadIds = expectedThreadIds;
      receipt.phase = "complete";
      await emitProgress();
      await deps.writeReceipt(receiptPath, receipt);
      return receipt;
    }

    deps.signal?.throwIfAborted();
    phase = receipt.phase = "publish";
    await emitProgress();
    deps.signal?.throwIfAborted();
    const currentPullRequest = await authorized.repositoryClient.getPullRequest(ref.number);
    if (currentPullRequest.state !== "open") throw new Error("pull request is no longer open");
    if (
      currentPullRequest.headSha !== authorized.pullRequest.headSha ||
      currentPullRequest.headBranch !== authorized.pullRequest.headBranch
    ) {
      throw new Error("pull request head moved after authorization");
    }
    const remoteHead = await authorized.repositoryClient.getBranchSha(authorized.pullRequest.headBranch);
    if (remoteHead !== authorized.pullRequest.headSha) throw new Error("pull request head moved after authorization");
    deps.signal?.throwIfAborted();
    if (changes.changedFiles.length > 0) {
      const finalChanges = await workspace.inspectChanges();
      assertUnchangedInspection(changes, finalChanges);
      deps.signal?.throwIfAborted();
      await workspace.quiesce();
      deps.signal?.throwIfAborted();
      await workspace.assertRunIdentity(authorized.pullRequest.headSha, authorized.pullRequest.headBranch);
      deps.signal?.throwIfAborted();
      receipt.commitSha = await workspace.commit(`fix: address review feedback (#${authorized.pullRequest.number})`);
      deps.signal?.throwIfAborted();
      await authorized.withInstallationToken((token) => workspace!.push(authorized.pullRequest.headBranch, token));
      const pushedHead = await authorized.repositoryClient.getBranchSha(authorized.pullRequest.headBranch);
      if (pushedHead !== receipt.commitSha) throw new Error("pushed pull request head does not match the generated commit");
      await emitProgress();
    } else {
      await workspace.quiesce();
    }

    deps.signal?.throwIfAborted();
    phase = receipt.phase = "threads";
    await emitProgress();
    for (const outcome of outcomes) {
      deps.signal?.throwIfAborted();
      const originalThread = threads.find((thread) => thread.id === outcome.threadId)!;
      const latestThread = (await authorized.repositoryClient.listReviewThreads(ref.number))
        .find((thread) => thread.id === outcome.threadId) ?? originalThread;
      const existingReply = findMarkedReply(latestThread, runId);
      const reply = existingReply ?? await authorized.repositoryClient.replyToReviewThread(
        outcome.threadId,
        buildThreadReply(originalThread, outcome, runId, request.verifyCommand),
      );
      let resolved = latestThread.isResolved;
      if (outcome.outcome !== "needs-human" && !resolved) {
        resolved = (await authorized.repositoryClient.resolveReviewThread(outcome.threadId)).isResolved;
        if (!resolved) throw new Error(`review thread did not resolve: ${outcome.threadId}`);
      }
      receipt.threadResults.push({
        threadId: outcome.threadId,
        outcome: outcome.outcome,
        replyUrl: reply.url,
        resolved,
      });
      await emitProgress();
    }

    const finalThreads = await authorized.repositoryClient.listReviewThreads(ref.number);
    const finalById = new Map(finalThreads.map((thread) => [thread.id, thread]));
    for (const result of receipt.threadResults) {
      const final = finalById.get(result.threadId);
      if (!final) throw new Error(`review thread disappeared during reconciliation: ${result.threadId}`);
      if (result.outcome !== "needs-human" && !final.isResolved) {
        throw new Error(`review thread remains unresolved: ${result.threadId}`);
      }
    }
    receipt.remainingOpenThreadIds = unresolvedCurrentThreads(finalThreads).map((thread) => thread.id);
    receipt.phase = "complete";
    await emitProgress();
    await deps.writeReceipt(receiptPath, receipt);
    return receipt;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    receipt.phase = phase;
    receipt.errorCode =
      phase === "agent" && error instanceof PiAgentOutputError
        ? PI_AGENT_OUTPUT_ERROR_CODE
        : phase === "agent" && isProviderQuotaError(message)
            ? PROVIDER_QUOTA_ERROR_CODE
            : phase === "agent" && error instanceof ReviewOutcomeMissingError
              ? REVIEW_OUTCOME_MISSING_ERROR_CODE
              : `${phase}_failed`;
    receipt.errorMessage = redactSecrets(message);
    await emitProgress();
    await deps.writeReceipt(receiptPath, receipt);
    throw error;
  } finally {
    await workspace?.destroy();
  }
}

function markLastAgentAttemptFailed(execution: AgentExecution): void {
  const attempts = execution.attempts;
  const attempt = attempts?.[attempts.length - 1];
  if (attempt?.outcome === "succeeded") attempt.outcome = "failed";
}

export const defaultReviewReceiptWriter = writeReviewReceipt;

function assertUnchangedInspection(before: ChangeInspection, after: ChangeInspection): void {
  if (
    before.patch !== after.patch ||
    before.changedFiles.join("\0") !== after.changedFiles.join("\0")
  ) {
    throw new Error("repository changes moved after policy inspection");
  }
}

function buildThreadReply(
  thread: ReviewThread,
  outcome: ReviewOutcome,
  runId: string,
  verifyCommand: string,
): string {
  const source = thread.comments[0]?.body ?? "Original review comment";
  const quote = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280) || "Original review comment";
  const prefix = {
    fixed: "Addressed",
    deferred: "Deferred",
    rejected: "Not addressing",
    "needs-human": "Needs operator input",
  }[outcome.outcome];
  const followUp = outcome.followUp ? `\n\nFollow-up: ${outcome.followUp}` : "";
  return [
    `> ${quote}`,
    `${prefix}: ${outcome.summary}`,
    `Evidence: ${outcome.evidence}${followUp}`,
    `Independent verification passed: \`${verifyCommand}\``,
    reviewRunMarker(runId, thread.id),
  ].join("\n\n");
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("run interrupted"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
