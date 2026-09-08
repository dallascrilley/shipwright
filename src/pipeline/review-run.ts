import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  acquireNativeFileLock,
  type NativeFileLockHandle,
} from "./native-file-lock.js";
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
import { findMarkedReply, reviewRunMarker, reviewThreadContentDigest, unresolvedCurrentThreads } from "../github/review-client.js";
import type { PullRequestRef, ReviewThread } from "../github/types.js";
import { openOrReuseFollowUpPullRequest } from "../github/publisher.js";
import type { ChangeInspection } from "../sandbox/runtime.js";
import {
  createReviewCandidate,
  createReviewEvidenceToken,
  computeReviewChecksDigest,
  reviewCandidatePatch,
  reviewCandidatePath,
  writeReviewCandidate,
  type ReviewAuthorizedDeliveryPlan,
  type ReviewCandidate,
  type ReviewEffectJournalStore,
  type ReviewEffectReceipt,
  type ReviewFindingVerificationRecord,
  type ReviewVerificationPlanStore,
  type ReviewVerificationResult,
} from "./repair-candidate.js";
import { assertPublishableChange } from "./policy.js";
import {
  parseReviewOutcomes,
  resolveVerifiedReviewOutcomes,
  type ReviewOutcome,
  type ResolvedReviewOutcome,
} from "./review-outcomes.js";
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
  clonePullRequest(input: {
    owner: string;
    repo: string;
    headBranch: string;
    headSha: string;
    token: string;
  }): Promise<void>;
  prepareForAgent(): Promise<void>;
  prepareReviewArtifact(path: string): Promise<void>;
  readAndRemoveArtifact(path: string): Promise<string>;
  verify(
    command: string,
    timeoutMs: number,
  ): Promise<{ exitCode?: number | null; stdout?: string; stderr?: string }>;
  /** Runs a host-owned reproduction against baseline and replayed candidate. */
  verifyReviewPlan?(input: {
    baselineSha: string;
    patch: Uint8Array;
    command: string;
    timeoutMs: number;
  }): Promise<{
    baseline: ReviewVerificationResult;
    candidate: ReviewVerificationResult;
  }>;
  /**
   * Change set of the workspace against the authorized head, computed with
   * host-side git and a scratch index so an agent that commits, sets
   * skip-worktree, or tampers with sandbox git config cannot hide a change.
   */
  inspectChanges(authorizedHeadSha: string): Promise<ChangeInspection>;
  quiesce(): Promise<void>;
  assertRunIdentity(headSha: string, branch: string): Promise<void>;
  commit(message: string): Promise<string>;
  /** Required to reconcile a confirmed local commit before a lost push ack. */
  restoreCommittedReview?(commitSha: string, branch: string): Promise<void>;
  /** Required only when replaying a retained candidate. */
  applyReviewCandidatePatch?(patch: Uint8Array): Promise<void>;
  /** Required for follow-up PR delivery. */
  resetToReviewBase?(baseSha: string, branch: string): Promise<void>;
  push(branch: string, token: string): Promise<void>;
  destroy(): Promise<void>;
}

export interface ReviewCandidateLoader {
  load(candidateId: string): Promise<ReviewCandidate>;
}

export interface ReviewVerificationStore {
  put(record: ReviewFindingVerificationRecord): Promise<void>;
  lookup(input: {
    recordId: string;
    candidateDigest: string;
    findingId: string;
    findingDigest: string;
    checksDigest: string;
  }): Promise<ReviewFindingVerificationRecord | undefined>;
}

export interface ReviewFindingVerifier {
  verify(input: {
    candidate: ReviewCandidate;
    findingId: string;
    workspace: ReviewWorkspacePort;
    checks: { command: string; exitCode: number | null; passed: boolean; requiredChecks: "passed" | "failed" | "pending" };
  }): Promise<ReviewFindingVerificationRecord | undefined>;
}

export interface ReviewPipelineDependencies {
  execution: AgentExecution;
  skill: AgentSkillProjection & { name: "fix-review-findings"; sha256: string };
  authorize(ref: PullRequestRef): Promise<AuthorizedPullRequest>;
  createWorkspace(): Promise<ReviewWorkspacePort>;
  runAgent(workspace: ReviewWorkspacePort, prompt: string, timeoutMs: number, skills: AgentSkillProjection[]): Promise<string>;
  writeReceipt(path: string, receipt: ReviewRunReceipt): Promise<void>;
  artifactRoot?: string;
  candidateRoot?: string;
  candidateLoader?: ReviewCandidateLoader;
  verificationStore?: ReviewVerificationStore;
  verificationPlanStore?: ReviewVerificationPlanStore;
  findingVerifier?: ReviewFindingVerifier;
  effectJournalFactory?: (candidate: ReviewCandidate) => Promise<ReviewEffectJournalStore>;
  publicationLease?: ReviewPublicationLease;
  runId?: string;
  signal?: AbortSignal;
  onProgress?: (receipt: ReviewRunReceipt) => void | Promise<void>;
}

export interface ReviewPublicationLease {
  acquire(key: string): Promise<() => Promise<void>>;
}

/** Host-wide per-PR publication lease shared by CLI and UI state. */
export class FileReviewPublicationLease implements ReviewPublicationLease {
  constructor(private readonly root: string) {}

  async acquire(key: string): Promise<() => Promise<void>> {
    if (!key.trim()) throw new Error("publication lease key is required");
    const digest = createHash("sha256").update(key).digest("hex");
    const lockPath = join(this.root, "review-publication-leases", `${digest}.lock`);
    const lock: NativeFileLockHandle = await acquireNativeFileLock(lockPath);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await lock.release();
    };
  }
}

export type ReviewDeliveryMode = "patch" | "commit" | "follow-up-pr" | "evidence-only";

export interface ReviewRunRequest {
  pullRequestUrl: string;
  verifyCommand: string;
  /**
   * Repo-relative files or directories the verification command depends on.
   * An agent change touching one fails the run before verification executes,
   * so a tampered gate can never green its own check.
   */
  candidateId?: string;
  protectedPaths?: readonly string[];
  reviewScope?: {
    findingIds: readonly string[];
  };
  followUpBaseSha?: string;
  publish: boolean;
  deliveryMode?: ReviewDeliveryMode;
  timeoutMinutes: number;
}
export async function runReviewAgent(
  request: ReviewRunRequest,
  deps: ReviewPipelineDependencies,
): Promise<ReviewRunReceipt> {
  const runId = deps.runId ?? randomBytes(8).toString("hex");
  const deliveryMode = request.deliveryMode ?? (request.publish ? "commit" : "patch");
  const receiptPath = join(
    deps.artifactRoot ?? ".artifacts/shipwright/review-receipts",
    runId,
    "receipt.json",
  );
  const receipt: ReviewRunReceipt = {
    runId,
    phase: "intake",
    pullRequestUrl: request.pullRequestUrl,
    deliveryMode,
    ...(request.candidateId ? { candidateId: request.candidateId } : {}),
    execution: deps.execution,
    skill: { name: deps.skill.name, sha256: deps.skill.sha256 },
    changedFiles: [],
    verification: { command: request.verifyCommand, exitCode: null, passed: false },
    threadResults: [],
    remainingOpenThreadIds: [],
  };
  const emitProgress = async () => deps.onProgress?.(structuredClone(receipt));
  let workspace: ReviewWorkspacePort | undefined;
  let releasePublicationLease: (() => Promise<void>) | undefined;
  let phase: ReviewRunPhase = "intake";
  try {
    await emitProgress();
    const ref = parsePullRequestUrl(request.pullRequestUrl);
    const authorized = await deps.authorize(ref);
    deps.signal?.throwIfAborted();

    const resumedCandidate = request.candidateId
      ? await (deps.candidateLoader
        ? deps.candidateLoader.load(request.candidateId)
        : Promise.reject(new Error("candidateId requires candidateLoader")))
      : undefined;
    if (resumedCandidate && resumedCandidate.authorizedBaseSha !== authorized.pullRequest.baseSha) {
      throw new Error("retained candidate authorized base moved");
    }

    let effectJournal: ReviewEffectJournalStore | undefined;
    let effects: ReviewEffectReceipt[] = [];
    if (resumedCandidate && deps.effectJournalFactory) {
      effectJournal = await deps.effectJournalFactory(resumedCandidate);
      effects = await effectJournal.load();
    }
    const operationId = resumedCandidate?.candidateId ?? runId;
    receipt.candidateId = resumedCandidate?.candidateId ?? request.candidateId;
    receipt.candidateDigest = resumedCandidate?.candidateDigest;

    const allThreads = authorized.reviewThreads;
    const scopedFindingIds = request.reviewScope?.findingIds;
    const scopedFindingSet = scopedFindingIds ? new Set(scopedFindingIds) : undefined;
    if (scopedFindingSet) {
      const knownFindingIds = new Set(allThreads.map((thread) => thread.id));
      const missing = [...scopedFindingSet].filter((findingId) => !knownFindingIds.has(findingId));
      if (missing.length > 0) {
        throw new Error(`review scope finding disappeared: ${missing.join(", ")}`);
      }
    }
    const scopedThreads = scopedFindingSet
      ? allThreads.filter((thread) => scopedFindingSet.has(thread.id))
      : allThreads;
    const threads = resumedCandidate
      ? resumedCandidate.findings
        .filter((finding) => !scopedFindingSet || scopedFindingSet.has(finding.findingId))
        .map((finding) => {
          const thread = allThreads.find((candidate) => candidate.id === finding.findingId);
          if (!thread) throw new Error(`retained candidate thread disappeared: ${finding.findingId}`);
          const digest = reviewThreadContentDigest(thread);
          if (!finding.originalContentDigest || finding.originalContentDigest !== digest) {
            throw new Error(`retained candidate review thread changed: ${finding.findingId}`);
          }
          return thread;
        })
      : unresolvedCurrentThreads(scopedThreads);
    const expectedThreadIds = threads.map((thread) => thread.id);
    const originalHeadSha = resumedCandidate?.authorizedHeadSha ?? authorized.pullRequest.headSha;
    const confirmedCommitSha = effects.find(
      (effect) => effect.kind === "commit" && effect.status === "confirmed" && effect.commitSha,
    )?.commitSha;
    const confirmedPushSha = effects.find(
      (effect) => effect.kind === "push" && effect.status === "confirmed" && effect.commitSha,
    )?.commitSha;
    const currentHeadSha = authorized.pullRequest.headSha;
    const retainedHeadIsKnown = !resumedCandidate
      || currentHeadSha === originalHeadSha
      || currentHeadSha === confirmedCommitSha
      || currentHeadSha === confirmedPushSha;
    if (!retainedHeadIsKnown) throw new Error("retained candidate pull request head moved");
    const cloneHeadSha = resumedCandidate && (currentHeadSha === confirmedPushSha || currentHeadSha === confirmedCommitSha)
      ? currentHeadSha
      : originalHeadSha;

    receipt.authorizedBaseSha = authorized.pullRequest.baseSha;
    receipt.authorizedHeadSha = originalHeadSha;
    receipt.headBranch = authorized.pullRequest.headBranch;
    phase = receipt.phase = "workspace";
    await emitProgress();
    workspace = await deps.createWorkspace();
    await authorized.withInstallationToken((token) => workspace!.clonePullRequest({
      owner: authorized.pullRequest.owner,
      repo: authorized.pullRequest.repo,
      headBranch: authorized.pullRequest.headBranch,
      headSha: cloneHeadSha,
      token,
    }));
    deps.signal?.throwIfAborted();
    await workspace.prepareForAgent();

    let outcomes: ReviewOutcome[];
    if (resumedCandidate) {
      if (cloneHeadSha === originalHeadSha) {
        if (!workspace.applyReviewCandidatePatch) {
          throw new Error("retained candidate replay is unsupported by this workspace");
        }
        await workspace.applyReviewCandidatePatch(Buffer.from(resumedCandidate.patchBase64, "base64"));
      }
      outcomes = resumedCandidate.findings
        .filter((finding) => !scopedFindingSet || scopedFindingSet.has(finding.findingId))
        .map((finding) => ({
          threadId: finding.findingId,
          outcome: finding.proposedOutcome,
          summary: finding.summary,
          evidence: finding.evidence,
          ...(finding.reproduction ? { followUp: finding.reproduction } : {}),
          ...(finding.repairIdentity ? { repairIdentity: finding.repairIdentity } : {}),
        }));
    } else {
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
        const original = readError instanceof Error ? readError.message : String(readError);
        const detail = redactSecrets(truncateTail(agentResponse)).trim() || "(no agent output)";
        markLastAgentAttemptFailed(deps.execution);
        throw new ReviewOutcomeMissingError(
          `review agent finished without writing ${REVIEW_OUTCOME_PATH} (${original}); agent response: ${detail}`,
        );
      }
      outcomes = parseReviewOutcomes(serializedOutcomes, expectedThreadIds);
    }

    phase = receipt.phase = "verify";
    await emitProgress();
    const verification = await abortable(
      workspace.verify(request.verifyCommand, request.timeoutMinutes * 60_000),
      deps.signal,
    );
    receipt.verification.exitCode = verification.exitCode ?? null;
    receipt.verification.passed = verification.exitCode === 0;
    if (verification.stdout) receipt.verification.stdoutTail = redactSecrets(truncateTail(verification.stdout));
    if (verification.stderr) receipt.verification.stderrTail = redactSecrets(truncateTail(verification.stderr));
    await emitProgress();
    if (!receipt.verification.passed) throw new Error("independent verification failed");

    deps.signal?.throwIfAborted();
    phase = receipt.phase = "policy";
    await emitProgress();
    await workspace.quiesce();
    const changes = await workspace.inspectChanges(originalHeadSha);
    receipt.changedFiles = changes.changedFiles;
    if (changes.changedFiles.length > 0) assertPublishableChange(changes, request.protectedPaths ?? []);
    let retainedCandidate = resumedCandidate;
    if (retainedCandidate && changes.resultingTreeSha && changes.resultingTreeSha !== retainedCandidate.resultingTreeSha) {
      throw new Error("retained candidate resulting tree does not match");
    }
    if (!retainedCandidate && deps.candidateRoot) {
      const patch = changes.patchData ?? new TextEncoder().encode(changes.patch);
      retainedCandidate = createReviewCandidate({
        candidateId: runId,
        authorizedBaseRef: `refs/heads/${authorized.pullRequest.baseBranch}`,
        authorizedBaseSha: authorized.pullRequest.baseSha,
        authorizedHeadRef: `refs/pull/${authorized.pullRequest.number}/head`,
        authorizedHeadSha: authorized.pullRequest.headSha,
        resultingTreeSha: changes.resultingTreeSha ?? "",
        patch,
        changedFiles: changes.changedFiles,
        findings: outcomes.map((outcome) => {
          const thread = threads.find((item) => item.id === outcome.threadId)!;
          return {
            findingId: outcome.threadId,
            originalContentDigest: reviewThreadContentDigest(thread),
            proposedOutcome: outcome.outcome,
            summary: outcome.summary,
            evidence: outcome.evidence,
            reproduction: outcome.followUp ?? "",
            affectedFiles: [thread.path],
            ...(outcome.repairIdentity ? { repairIdentity: outcome.repairIdentity } : {}),
          };
        }),
        verification: {
          command: request.verifyCommand,
          exitCode: receipt.verification.exitCode,
          passed: receipt.verification.passed,
          requiredChecks: receipt.verification.passed ? "passed" : "failed",
          stdoutTail: receipt.verification.stdoutTail,
          stderrTail: receipt.verification.stderrTail,
        },
        deliveryMode,
        createdAt: new Date().toISOString(),
      });
      await writeReviewCandidate(
        reviewCandidatePath(deps.candidateRoot, retainedCandidate.candidateId),
        retainedCandidate,
      );
      effectJournal = deps.effectJournalFactory
        ? await deps.effectJournalFactory(retainedCandidate)
        : undefined;
      effects = effectJournal ? await effectJournal.load() : [];
    }

    const checks = {
      command: request.verifyCommand,
      exitCode: receipt.verification.exitCode,
      passed: receipt.verification.passed,
      requiredChecks: receipt.verification.passed ? "passed" as const : "failed" as const,
    };
    const checksDigest = computeReviewChecksDigest(checks);
    const verificationRecordsByFinding = new Map<string, ReviewFindingVerificationRecord>();
    if (retainedCandidate && deps.candidateRoot && deps.verificationStore && deps.findingVerifier) {
      const tokens = [];
      for (const finding of retainedCandidate.findings) {
        const findingDigest = finding.originalContentDigest;
        if (!findingDigest) continue;
        const existingToken = retainedCandidate.verificationRecords.find((token) => token.findingId === finding.findingId);
        let record = existingToken
          ? await deps.verificationStore.lookup({
            recordId: existingToken.recordId,
            candidateDigest: retainedCandidate.candidateDigest,
            findingId: finding.findingId,
            findingDigest,
            checksDigest,
          })
          : undefined;
        if (!record) {
          const proposed = await deps.findingVerifier.verify({
            candidate: retainedCandidate,
            findingId: finding.findingId,
            workspace,
            checks,
          });
          if (proposed) {
            if (
              proposed.candidateDigest !== retainedCandidate.candidateDigest
              || proposed.findingId !== finding.findingId
              || proposed.findingDigest !== findingDigest
              || proposed.checksDigest !== checksDigest
            ) {
              throw new Error(`host verification record binding mismatch: ${finding.findingId}`);
            }
            await deps.verificationStore.put(proposed);
            record = await deps.verificationStore.lookup({
              recordId: proposed.recordId,
              candidateDigest: retainedCandidate.candidateDigest,
              findingId: finding.findingId,
              findingDigest,
              checksDigest,
            });
          }
        }
        if (record) {
          try {
            tokens.push(createReviewEvidenceToken(record));
            verificationRecordsByFinding.set(finding.findingId, record);
          } catch {
            // A malformed or pending host record remains unresolved.
          }
        }
      }
      retainedCandidate.verificationRecords = tokens;
      await writeReviewCandidate(
        reviewCandidatePath(deps.candidateRoot, retainedCandidate.candidateId),
        retainedCandidate,
      );
    }
    if (retainedCandidate) {
      receipt.candidateId = retainedCandidate.candidateId;
      receipt.candidateDigest = retainedCandidate.candidateDigest;
    }

    let resolvedOutcomes: ResolvedReviewOutcome[] | undefined;
    if (retainedCandidate && deps.verificationStore) {
      const findings = Object.fromEntries(retainedCandidate.findings.map((finding) => {
        const token = retainedCandidate.verificationRecords.find((item) => item.findingId === finding.findingId);
        return [finding.findingId, {
          recordId: token?.recordId ?? "",
          findingId: finding.findingId,
          findingContentDigest: finding.originalContentDigest ?? "",
        }];
      }));
      resolvedOutcomes = await resolveVerifiedReviewOutcomes(outcomes, {
        candidateDigest: retainedCandidate.candidateDigest,
        checksDigest,
        findings,
        store: deps.verificationStore,
      });
    }
    const resolvedByThread = new Map(
      resolvedOutcomes?.map((item) => [item.threadId, item]) ?? [],
    );
    const effectiveOutcomes = new Map(
      outcomes.map((outcome) => {
        const resolved = resolvedByThread.get(outcome.threadId);
        const disposition = resolved?.verified.disposition;
        if (
          !resolved
          || resolved.verified.status === "pending"
          || disposition === "pending"
        ) {
          return [outcome.threadId, outcome] as const;
        }
        const hostFollowUp = verificationRecordsByFinding.get(outcome.threadId)?.followUp?.remoteUrl;
        return [outcome.threadId, {
          ...outcome,
          outcome: disposition,
          ...(disposition === "deferred" && !outcome.followUp && hostFollowUp
            ? { followUp: hostFollowUp }
            : {}),
        }] as const;
      }),
    );
    if (changes.changedFiles.length === 0 && [...effectiveOutcomes.values()].some((item) => item.outcome === "fixed")) {
      throw new Error("fixed review outcomes require a repository change");
    }
    const pendingThreadIds = new Set(
      resolvedOutcomes
        ?.filter((item) => item.verified.status === "pending")
        .map((item) => item.threadId) ?? expectedThreadIds,
    );
    receipt.threadResults = outcomes.map((outcome) => {
      const resolved = resolvedByThread.get(outcome.threadId);
      const verified = resolved?.verified ?? (
        outcome.outcome === "needs-human"
          ? { disposition: "needs-human" as const, status: "not-required" as const, reason: "model requested human review" }
          : { disposition: "pending" as const, status: "pending" as const, reason: "missing durable host verification" }
      );
      return {
        threadId: outcome.threadId,
        outcome: outcome.outcome,
        proposedOutcome: outcome.outcome,
        verifiedDisposition: verified.disposition,
        verificationStatus: verified.status,
        ...(verified.reason ? { verificationReason: verified.reason } : {}),
        ...(verified.recordId ? { verificationRecordId: verified.recordId } : {}),
        replyUrl: "",
        resolved: threads.find((thread) => thread.id === outcome.threadId)?.isResolved ?? false,
      };
    });
    await emitProgress();

    if (!request.publish || deliveryMode === "patch" || deliveryMode === "evidence-only") {
      const latestThreads = await authorized.repositoryClient.listReviewThreads(ref.number);
      const latestById = new Map(latestThreads.map((thread) => [thread.id, thread]));
      receipt.remainingOpenThreadIds = expectedThreadIds.filter((threadId) => {
        const latest = latestById.get(threadId);
        return latest !== undefined && !latest.isResolved;
      });
      receipt.phase = "complete";
      await emitProgress();
      await deps.writeReceipt(receiptPath, receipt);
      return receipt;
    }

    if (!retainedCandidate || !deps.candidateRoot || !effectJournal) {
      throw new Error("publication requires a durable review candidate and effect journal");
    }
    const followUpBaseSha =
      deliveryMode === "follow-up-pr"
        ? request.followUpBaseSha ?? retainedCandidate.authorizedHeadSha
        : undefined;
    if (
      deliveryMode === "follow-up-pr"
      && request.followUpBaseSha !== undefined
      && request.followUpBaseSha !== retainedCandidate.authorizedHeadSha
    ) {
      throw new Error("follow-up patch base does not match the selected follow-up base SHA");
    }
    if (deps.publicationLease) {
      releasePublicationLease = await deps.publicationLease.acquire(
        `${ref.owner}/${ref.repo}#${ref.number}`,
      );
    }
    const deliveryPlan: ReviewAuthorizedDeliveryPlan = {
      candidateDigest: retainedCandidate.candidateDigest,
      deliveryMode,
      owner: authorized.pullRequest.owner,
      repo: authorized.pullRequest.repo,
      pullRequestNumber: ref.number,
      baseBranch: authorized.pullRequest.baseBranch,
      baseSha: authorized.pullRequest.baseSha,
      headBranch: authorized.pullRequest.headBranch,
      authorizedHeadSha: originalHeadSha,
      ...(followUpBaseSha !== undefined ? { followUpBaseSha } : {}),
    };
    const authorizedDeliveryPlan = await effectJournal.ensureDeliveryPlan(deliveryPlan);


    const publishableOutcomes = outcomes
      .map((outcome) => {
        const resolved = resolvedByThread.get(outcome.threadId);
        return resolved?.verified.status === "verified"
          || resolved?.verified.status === "not-required"
          ? effectiveOutcomes.get(outcome.threadId)
          : undefined;
      })
      .filter((outcome): outcome is ReviewOutcome => outcome !== undefined);
    if (publishableOutcomes.length !== outcomes.length) {
      throw new Error("publication requires host-verified outcomes for every selected finding");
    }
    if (deliveryMode === "commit") {
      deps.signal?.throwIfAborted();
      await revalidateRemoteReviewState(
        authorized,
        ref.number,
        [originalHeadSha, confirmedCommitSha, confirmedPushSha].filter(
          (head): head is string => Boolean(head),
        ),
      );
      const remoteHead = await authorized.repositoryClient.getBranchSha(authorized.pullRequest.headBranch);
      if (remoteHead !== originalHeadSha && remoteHead !== confirmedCommitSha && remoteHead !== confirmedPushSha) {
        throw new Error("pull request head moved after authorization");
      }
      if (remoteHead === confirmedCommitSha || remoteHead === confirmedPushSha) {
        receipt.commitSha = remoteHead;
      }
      if (remoteHead === confirmedCommitSha && remoteHead !== confirmedPushSha) {
        const pushEffectId = `${operationId}:push`;
        const pushIntent = await effectJournal.beginEffect({
          effectId: pushEffectId,
          kind: "push",
          idempotencyKey: `${pushEffectId}:${remoteHead}`,
        });
        if (pushIntent.status === "confirmed") {
          if (pushIntent.commitSha !== remoteHead) {
            throw new Error("review push effect has a conflicting confirmed commit");
          }
        } else {
          await effectJournal.ackEffect({ effectId: pushEffectId, commitSha: remoteHead });
        }
      }
      if (changes.changedFiles.length > 0 && remoteHead === originalHeadSha) {
        phase = receipt.phase = "publish";
        await emitProgress();
        const commitEffectId = `${operationId}:commit`;
        const priorCommitEffect = effects.find((effect) => effect.effectId === commitEffectId);
        const commitIntent = await effectJournal.beginEffect({
          effectId: commitEffectId,
          kind: "commit",
          idempotencyKey: commitEffectId,
        });
        if (priorCommitEffect) {
          if (commitIntent.status === "confirmed" && commitIntent.commitSha) {
            receipt.commitSha = commitIntent.commitSha;
            if (!confirmedPushSha) {
              if (!workspace.restoreCommittedReview) {
                throw new Error("confirmed commit requires workspace commit reconciliation");
              }
              await workspace.restoreCommittedReview(
                receipt.commitSha,
                authorized.pullRequest.headBranch,
              );
            }
          } else {
            throw new Error("review commit effect requires reconciliation");
          }
        } else {
          try {
            receipt.commitSha = await workspace.commit(`fix: address review feedback (#${authorized.pullRequest.number})`);
            await effectJournal.ackEffect({ effectId: commitEffectId, commitSha: receipt.commitSha });
          } catch (error) {
            try {
              await effectJournal.markAmbiguous({ effectId: commitEffectId, detail: "commit result was not confirmed" });
            } catch {
              // Effect bookkeeping cannot mask the original commit result.
            }
            throw error;
          }
        }
        await revalidateRemoteReviewState(authorized, ref.number, originalHeadSha);
        const pushEffectId = `${operationId}:push`;
        const priorPushEffect = effects.find((effect) => effect.effectId === pushEffectId);
        const pushIntent = await effectJournal.beginEffect({
          effectId: pushEffectId,
          kind: "push",
          idempotencyKey: `${pushEffectId}:${receipt.commitSha}`,
        });
        if (priorPushEffect) {
          if (pushIntent.status !== "confirmed" || pushIntent.commitSha !== receipt.commitSha) {
            throw new Error("review push effect requires reconciliation");
          }
        } else {
          try {
            await authorized.withInstallationToken((token) => workspace!.push(authorized.pullRequest.headBranch, token));
            await effectJournal.ackEffect({ effectId: pushEffectId, commitSha: receipt.commitSha });
          } catch (error) {
            try {
              await effectJournal.markAmbiguous({ effectId: pushEffectId, detail: "push result was not confirmed" });
            } catch {
              // Effect bookkeeping cannot mask the original push result.
            }
            throw error;
          }
        }
      }
    } else if (deliveryMode === "follow-up-pr") {
      phase = receipt.phase = "publish";
      await emitProgress();
      const selectedFollowUpBaseSha = authorizedDeliveryPlan.followUpBaseSha;
      if (!selectedFollowUpBaseSha) {
        throw new Error("follow-up-pr requires an explicit selected base SHA");
      }
      if (selectedFollowUpBaseSha !== retainedCandidate.authorizedHeadSha) {
        throw new Error("follow-up patch base does not match the selected follow-up base SHA");
      }
      await revalidateRemoteReviewState(authorized, ref.number, originalHeadSha);
      if (!workspace.resetToReviewBase || !workspace.applyReviewCandidatePatch) {
        throw new Error("follow-up-pr requires a workspace that can reset and replay a candidate");
      }
      const followUpBranch = followUpBranchFor(retainedCandidate);
      await workspace.resetToReviewBase(selectedFollowUpBaseSha, followUpBranch);
      await workspace.applyReviewCandidatePatch(Buffer.from(retainedCandidate.patchBase64, "base64"));
      const followUpChanges = await workspace.inspectChanges(selectedFollowUpBaseSha);
      if (followUpChanges.resultingTreeSha !== retainedCandidate.resultingTreeSha) {
        throw new Error("follow-up base produced a different candidate tree");
      }
      await workspace.assertRunIdentity(selectedFollowUpBaseSha, followUpBranch);
      await revalidateRemoteReviewState(authorized, ref.number, originalHeadSha);
      const commitEffectId = `${operationId}:follow-up-commit`;
      const priorCommitEffect = effects.find((effect) => effect.effectId === commitEffectId);
      const commitIntent = await effectJournal.beginEffect({
        effectId: commitEffectId,
        kind: "commit",
        idempotencyKey: commitEffectId,
      });
      let followUpCommitSha: string;
      if (priorCommitEffect) {
        if (commitIntent.status !== "confirmed" || !commitIntent.commitSha) {
          throw new Error("follow-up commit effect requires reconciliation");
        }
        followUpCommitSha = commitIntent.commitSha;
      } else {
        try {
          followUpCommitSha = await workspace.commit(`fix: carry review candidate ${retainedCandidate.candidateId}`);
          await effectJournal.ackEffect({ effectId: commitEffectId, commitSha: followUpCommitSha });
        } catch (error) {
          try {
            await effectJournal.markAmbiguous({ effectId: commitEffectId, detail: "follow-up commit result was not confirmed" });
          } catch {
            // Effect bookkeeping cannot mask the original follow-up commit result.
          }
          throw error;
        }
      }
      await revalidateRemoteReviewState(authorized, ref.number, originalHeadSha);
      const pushEffectId = `${operationId}:follow-up-push`;
      const priorPushEffect = effects.find((effect) => effect.effectId === pushEffectId);
      const pushIntent = await effectJournal.beginEffect({
        effectId: pushEffectId,
        kind: "push",
        idempotencyKey: `${pushEffectId}:${followUpCommitSha}`,
      });
      let followUpHead: string;
      if (priorPushEffect && pushIntent.status === "confirmed") {
        if (pushIntent.commitSha !== followUpCommitSha) {
          throw new Error("follow-up push effect has a conflicting confirmed commit");
        }
        followUpHead = await authorized.repositoryClient.getBranchSha(followUpBranch);
      } else {
        followUpHead = await authorized.repositoryClient.getBranchSha(followUpBranch);
        if (followUpHead === followUpCommitSha) {
          await effectJournal.ackEffect({ effectId: pushEffectId, commitSha: followUpCommitSha });
        } else if (priorPushEffect) {
          throw new Error("follow-up push effect requires reconciliation");
        } else {
          try {
            await authorized.withInstallationToken((token) => workspace!.push(followUpBranch, token));
            followUpHead = await authorized.repositoryClient.getBranchSha(followUpBranch);
            if (followUpHead !== followUpCommitSha) {
              throw new Error("follow-up branch head does not match candidate commit");
            }
            await effectJournal.ackEffect({ effectId: pushEffectId, commitSha: followUpCommitSha });
          } catch (error) {
            try {
              await effectJournal.markAmbiguous({ effectId: pushEffectId, detail: "follow-up push result was not confirmed" });
            } catch {
              // Effect bookkeeping cannot mask the original follow-up push result.
            }
            throw error;
          }
        }
      }
      if (followUpHead !== followUpCommitSha) throw new Error("follow-up branch head does not match candidate commit");
      await revalidateRemoteReviewState(authorized, ref.number, originalHeadSha);
      const followUpEffectId = `${operationId}:follow-up-pr`;
      const priorFollowUpEffect = effects.find((effect) => effect.effectId === followUpEffectId);
      const followUpIntent = await effectJournal.beginEffect({
        effectId: followUpEffectId,
        kind: "follow-up-pr",
        idempotencyKey: followUpEffectId,
      });
      let followUpUrl: string | undefined;
      if (priorFollowUpEffect && followUpIntent.status === "confirmed") {
        if (!followUpIntent.remoteUrl) {
          throw new Error("follow-up pull request effect requires reconciliation");
        }
        await revalidateConfirmedFollowUpPullRequest(
          authorized,
          followUpIntent.remoteUrl,
          followUpBranch,
          followUpCommitSha,
          retainedCandidate.candidateId,
          retainedCandidate.candidateDigest,
        );
        followUpUrl = followUpIntent.remoteUrl;
      } else {
        try {
          const followUp = await openOrReuseFollowUpPullRequest(authorized.repositoryClient, {
            owner: authorized.pullRequest.owner,
            repo: authorized.pullRequest.repo,
            title: `Follow-up for #${authorized.pullRequest.number}`,
            branch: followUpBranch,
            baseBranch: authorized.pullRequest.baseBranch,
            commitSha: followUpCommitSha,
            candidateId: retainedCandidate.candidateId,
            candidateDigest: retainedCandidate.candidateDigest,
            body: `Host-verified review candidate ${retainedCandidate.candidateId}.`,
          });
          await revalidateConfirmedFollowUpPullRequest(
            authorized,
            followUp.url,
            followUpBranch,
            followUpCommitSha,
            retainedCandidate.candidateId,
            retainedCandidate.candidateDigest,
          );
          followUpUrl = followUp.url;
          await effectJournal.ackEffect({
            effectId: followUpEffectId,
            remoteId: String(followUp.number),
            remoteUrl: followUp.url,
          });
        } catch (error) {
          try {
            await effectJournal.markAmbiguous({ effectId: followUpEffectId, detail: "follow-up pull request result was not confirmed" });
          } catch {
            // Effect bookkeeping cannot mask the original follow-up PR result.
          }
          throw error;
        }
      }
      if (!followUpUrl) throw new Error("follow-up pull request URL is unavailable for reconciliation");
      receipt.commitSha = followUpCommitSha;
      receipt.followUpPullRequestUrl = followUpUrl;
      // Follow-up publication never replies to or resolves the original
      // findings. The real follow-up PR is linked by the receipt/effect journal.
      receipt.remainingOpenThreadIds = expectedThreadIds;
      receipt.phase = "complete";
      await emitProgress();
      await deps.writeReceipt(receiptPath, receipt);
      return receipt;
    }

    deps.signal?.throwIfAborted();
    phase = receipt.phase = "threads";
    await emitProgress();
    const latestThreads = await authorized.repositoryClient.listReviewThreads(ref.number);
    const latestById = new Map(latestThreads.map((thread) => [thread.id, thread]));
    for (const thread of threads) {
      const latest = latestById.get(thread.id);
      if (!latest) throw new Error(`review thread disappeared during reauthorization: ${thread.id}`);
      if (reviewThreadContentDigest(latest) !== reviewThreadContentDigest(thread)) {
        throw new Error(`review thread content changed during reauthorization: ${thread.id}`);
      }
    }
    for (const outcome of publishableOutcomes) {
      deps.signal?.throwIfAborted();
      const currentExpectedHead = receipt.commitSha ?? originalHeadSha;
      await revalidateRemoteReviewState(authorized, ref.number, currentExpectedHead);
      const effectThreads = await authorized.repositoryClient.listReviewThreads(ref.number);
      const effectById = new Map(effectThreads.map((thread) => [thread.id, thread]));
      const originalThread = threads.find((thread) => thread.id === outcome.threadId)!;
      const latestThread = effectById.get(outcome.threadId);
      if (!latestThread) throw new Error(`review thread disappeared during effect authorization: ${outcome.threadId}`);
      if (reviewThreadContentDigest(latestThread) !== reviewThreadContentDigest(originalThread)) {
        throw new Error(`review thread content changed during effect authorization: ${outcome.threadId}`);
      }
      const existingReply = findMarkedReply(latestThread, operationId);
      const replyEffectId = `${operationId}:reply:${outcome.threadId}`;
      const replyIntent = await effectJournal.beginEffect({
        effectId: replyEffectId,
        kind: "reply",
        idempotencyKey: replyEffectId,
      });
      let reply: { url: string };
      if (existingReply) {
        reply = existingReply;
        if (replyIntent.status === "confirmed") {
          if (replyIntent.remoteUrl !== reply.url) {
            throw new Error(`review reply effect has a conflicting confirmed URL: ${outcome.threadId}`);
          }
        } else {
          await effectJournal.ackEffect({ effectId: replyEffectId, remoteUrl: reply.url });
        }
      } else if (replyIntent.status === "confirmed" || replyIntent.status === "ambiguous") {
        throw new Error(`review reply effect requires reconciliation: ${outcome.threadId}`);
      } else {
        try {
          reply = await authorized.repositoryClient.replyToReviewThread(
            outcome.threadId,
            buildThreadReply(originalThread, outcome, operationId, request.verifyCommand),
          );
          await effectJournal.ackEffect({ effectId: replyEffectId, remoteUrl: reply.url });
        } catch (error) {
          try {
            await effectJournal.markAmbiguous({ effectId: replyEffectId, detail: "reply result was not confirmed" });
          } catch {
            // Effect bookkeeping cannot mask the original reply result.
          }
          throw error;
        }
      }
      let resolved = latestThread.isResolved;
      const resolvedRecord = resolvedByThread.get(outcome.threadId);
      const mayResolve = resolvedRecord?.verified.status === "verified"
        || resolvedRecord?.verified.status === "not-required";
      if (mayResolve && outcome.outcome !== "needs-human") {
        const resolveEffectId = `${operationId}:resolve:${outcome.threadId}`;
        const priorResolveEffect = effects.find((effect) => effect.effectId === resolveEffectId);
        if (resolved && priorResolveEffect) {
          const resolveIntent = await effectJournal.beginEffect({
            effectId: resolveEffectId,
            kind: "resolve",
            idempotencyKey: resolveEffectId,
          });
          if (resolveIntent.status === "confirmed") {
            if (resolveIntent.remoteId !== outcome.threadId) {
              throw new Error(`review resolve effect has a conflicting confirmed thread: ${outcome.threadId}`);
            }
          } else {
            await effectJournal.ackEffect({ effectId: resolveEffectId, remoteId: outcome.threadId });
          }
        } else if (!resolved) {
          await revalidateRemoteReviewState(authorized, ref.number, currentExpectedHead);
          const resolveIntent = await effectJournal.beginEffect({
            effectId: resolveEffectId,
            kind: "resolve",
            idempotencyKey: resolveEffectId,
          });
          if (priorResolveEffect) {
            if (resolveIntent.status === "confirmed") {
              if (resolveIntent.remoteId !== outcome.threadId) {
                throw new Error(`review resolve effect has a conflicting confirmed thread: ${outcome.threadId}`);
              }
              resolved = true;
            } else {
              throw new Error(`review resolve effect requires reconciliation: ${outcome.threadId}`);
            }
          } else if (resolveIntent.status !== "intent") {
            throw new Error(`review resolve effect requires reconciliation: ${outcome.threadId}`);
          } else {
            try {
              resolved = (await authorized.repositoryClient.resolveReviewThread(outcome.threadId)).isResolved;
              await effectJournal.ackEffect({ effectId: resolveEffectId, remoteId: outcome.threadId });
            } catch (error) {
              try {
                await effectJournal.markAmbiguous({ effectId: resolveEffectId, detail: "resolve result was not confirmed" });
              } catch {
                // Effect bookkeeping cannot mask the original resolve result.
              }
              throw error;
            }
          }
          if (!resolved) throw new Error(`review thread did not resolve: ${outcome.threadId}`);
        }
      }
      const result = receipt.threadResults.find((item) => item.threadId === outcome.threadId);
      if (!result) throw new Error(`missing receipt result for review thread: ${outcome.threadId}`);
      result.replyUrl = reply.url;
      result.resolved = resolved;
      await emitProgress();
    }

    const finalThreads = await authorized.repositoryClient.listReviewThreads(ref.number);
    const finalById = new Map(finalThreads.map((thread) => [thread.id, thread]));
    for (const result of receipt.threadResults) {
      const final = finalById.get(result.threadId);
      if (!final) throw new Error(`review thread disappeared during reconciliation: ${result.threadId}`);
      if (
        result.verifiedDisposition !== "needs-human"
        && result.verifiedDisposition !== "pending"
        && result.verificationStatus !== "pending"
        && !final.isResolved
      ) {
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
    try {
      await emitProgress();
    } catch {
      // Progress delivery is best effort and cannot mask the original result.
    }
    try {
      await deps.writeReceipt(receiptPath, receipt);
    } catch {
      // Receipt persistence is best effort after an effect or run failure.
    }
    throw error;
  } finally {
    try {
      await workspace?.destroy();
    } catch {
      // Workspace cleanup cannot mask a confirmed remote effect or run error.
    }
    try {
      await releasePublicationLease?.();
    } catch {
      // Lease cleanup is best effort; the bounded lock prevents unsafe overlap.
    }
  }
}

async function revalidateRemoteReviewState(
  authorized: AuthorizedPullRequest,
  pullRequestNumber: number,
  expectedHeadSha: string | readonly string[],
): Promise<void> {
  const current = await authorized.repositoryClient.getPullRequest(pullRequestNumber);
  if (current.state !== "open") throw new Error("pull request is no longer open");
  if (
    current.baseSha !== authorized.pullRequest.baseSha
    || current.baseBranch !== authorized.pullRequest.baseBranch
    || current.headBranch !== authorized.pullRequest.headBranch
  ) {
    throw new Error("pull request base or branch changed after authorization");
  }
  const branchHead = await authorized.repositoryClient.getBranchSha(current.headBranch);
  const expectedHeads = new Set(
    typeof expectedHeadSha === "string" ? [expectedHeadSha] : expectedHeadSha,
  );
  if (!expectedHeads.has(branchHead) || current.headSha !== branchHead) {
    throw new Error("pull request head moved after authorization");
  }
}
function followUpBranchFor(
  candidate: Pick<ReviewCandidate, "candidateId" | "candidateDigest">,
): string {
  const candidateIdIsGitBranchSafe =
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(candidate.candidateId)
    && !candidate.candidateId.includes("..")
    && !candidate.candidateId.endsWith(".")
    && !candidate.candidateId.endsWith(".lock");
  return `shipwright/review-${
    candidateIdIsGitBranchSafe ? candidate.candidateId : candidate.candidateDigest
  }`;
}


async function revalidateConfirmedFollowUpPullRequest(
  authorized: AuthorizedPullRequest,
  followUpUrl: string,
  followUpBranch: string,
  followUpCommitSha: string,
  candidateId: string,
  candidateDigest: string,
): Promise<void> {
  const ref = parsePullRequestUrl(followUpUrl);
  if (
    ref.owner.toLowerCase() !== authorized.pullRequest.owner.toLowerCase()
    || ref.repo.toLowerCase() !== authorized.pullRequest.repo.toLowerCase()
  ) {
    throw new Error("confirmed follow-up pull request belongs to a different repository");
  }
  const current = await authorized.repositoryClient.getPullRequest(ref.number);
  const marker = `Shipwright-Candidate: ${candidateId} Digest: ${candidateDigest}`;
  if (
    current.state !== "open"
    || current.baseBranch !== authorized.pullRequest.baseBranch
    || current.baseSha !== authorized.pullRequest.baseSha
    || current.headBranch !== followUpBranch
    || current.headSha !== followUpCommitSha
    || current.headOwner.toLowerCase() !== authorized.pullRequest.owner.toLowerCase()
    || current.headRepo.toLowerCase() !== authorized.pullRequest.repo.toLowerCase()
    || (!current.title.includes(marker) && !current.body.includes(marker))
  ) {
    throw new Error("confirmed follow-up pull request no longer matches the candidate");
  }
  const branchHead = await authorized.repositoryClient.getBranchSha(followUpBranch);
  if (branchHead !== followUpCommitSha || current.headSha !== branchHead) {
    throw new Error("confirmed follow-up pull request branch head moved");
  }
}


function markLastAgentAttemptFailed(execution: AgentExecution): void {
  const attempts = execution.attempts;
  const attempt = attempts?.[attempts.length - 1];
  if (attempt?.outcome === "succeeded") attempt.outcome = "failed";
}

export const defaultReviewReceiptWriter = writeReviewReceipt;

function buildThreadReply(
  thread: ReviewThread,
  outcome: ReviewOutcome,
  runId: string,
  verifyCommand: string,
): string {
  const source = thread.comments.find((comment) => !comment.body.includes("agentos-review-run:"))?.body ?? "Original review comment";
  const quote = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280) || "Original review comment";
  const prefix = {
    fixed: "Addressed",
    deferred: "Deferred",
    rejected: "Not addressing",
    "already-addressed": "Already addressed",
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
