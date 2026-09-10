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
import { findMarkedReply, isGeneratedReviewReply, reviewRunMarker, reviewThreadContentDigest, unresolvedCurrentThreads } from "../github/review-client.js";
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
  type ReviewBaseFreshness,
  type ReviewCandidate,
  type ReviewEffectJournalStore,
  type ReviewEffectReceipt,
  type ReviewFindingVerificationRecord,
  type ReviewFixGroup,
  type ReviewOwnershipAuthorization,
  type ReviewScope,
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
/** Host actor used when no task-owner provenance is available. */
const UNATTRIBUTED_REVIEW_ACTOR = "shipwright";

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
    verificationHeadSha?: string;
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
  /** Proves a pushed integration head contains the exact generated commit. */
  assertCommitIncluded?(commitSha: string, headSha: string): Promise<void>;
  /** Proves descent from the original PR head; behavioral proof remains separate. */
  assertReviewIntegrationLineage?(baseSha: string, headSha: string): Promise<void>;
  /** Reconcile a confirmed commit, recreating it from the retained candidate when needed. */
  restoreCommittedReview?(input: {
    commitSha: string;
    branch: string;
    baseSha: string;
    expectedTreeSha: string;
    message: string;
  }): Promise<string>;
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
    checks: {
      command: string;
      exitCode: number | null;
      passed: boolean;
      requiredChecks: "passed" | "failed" | "pending";
      verificationBaseSha?: string;
      verificationHeadSha?: string;
    };
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
  reviewScope?: ReviewScope;
  fixGroups?: readonly ReviewFixGroup[];
  ownership?: ReviewOwnershipAuthorization;
  provenance?: {
    taskId: string;
    /** Host-authored owner of the original local PR task. */
    actor: string;
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
  const deliveryMode = request.deliveryMode ?? (request.publish ? "follow-up-pr" : "patch");
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
    lifecycle: "proposed",
    ...(request.ownership ? { ownership: structuredClone(request.ownership) } : {}),
    ...(request.reviewScope ? { reviewScope: structuredClone(request.reviewScope) } : {}),
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
    const baseFreshness = await observeReviewBaseFreshness(authorized);
    receipt.baseFreshness = baseFreshness;
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
    if (resumedCandidate && scopedFindingSet) {
      const retainedFindingIds = new Set(resumedCandidate.findings.map((finding) => finding.findingId));
      const missing = [...scopedFindingSet].filter((findingId) => !retainedFindingIds.has(findingId));
      if (missing.length > 0) {
        throw new Error(`review scope finding is absent from retained candidate: ${missing.join(", ")}`);
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
    assertReviewScope(request.reviewScope, authorized, originalHeadSha, threads);
    const confirmedCommitSha = effects.find(
      (effect) => effect.kind === "commit" && effect.status === "confirmed" && effect.commitSha,
    )?.commitSha;
    const confirmedPushSha = effects.find(
      (effect) => effect.kind === "push" && effect.status === "confirmed" && effect.commitSha,
    )?.commitSha;
    const confirmedFollowUpCommitSha = effects.find(
      (effect) =>
        effect.effectId === `${operationId}:follow-up-commit`
        && effect.kind === "commit"
        && effect.status === "confirmed"
        && effect.commitSha,
    )?.commitSha;
    const confirmedFollowUpPullRequestUrl = effects.find(
      (effect) =>
        effect.effectId === `${operationId}:follow-up-pr`
        && effect.kind === "follow-up-pr"
        && effect.status === "confirmed"
        && effect.remoteUrl,
    )?.remoteUrl;
    const currentHeadSha = authorized.pullRequest.headSha;
    const followUpIntegrationDetected = Boolean(
      resumedCandidate
      && deliveryMode === "follow-up-pr"
      && confirmedFollowUpCommitSha
      && confirmedFollowUpPullRequestUrl
      && currentHeadSha !== originalHeadSha,
    );
    const retainedHeadIsKnown = !resumedCandidate
      || currentHeadSha === originalHeadSha
      || currentHeadSha === confirmedCommitSha
      || currentHeadSha === confirmedPushSha
      || followUpIntegrationDetected;
    if (!retainedHeadIsKnown) throw new Error("retained candidate pull request head moved");
    const cloneHeadSha = followUpIntegrationDetected
      ? currentHeadSha
      : resumedCandidate && (currentHeadSha === confirmedPushSha || currentHeadSha === confirmedCommitSha)
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
    if (retainedCandidate && changes.resultingTreeSha && changes.resultingTreeSha !== retainedCandidate.resultingTreeSha && !followUpIntegrationDetected) {
      throw new Error("retained candidate resulting tree does not match");
    }
    if (followUpIntegrationDetected) {
      if (!workspace.assertReviewIntegrationLineage) {
        throw new Error("follow-up integration lacks lineage proof");
      }
      const workspaceChanges = await workspace.inspectChanges(currentHeadSha);
      if (workspaceChanges.changedFiles.length > 0) {
        throw new Error("follow-up integration workspace changed during verification");
      }
      await workspace.assertReviewIntegrationLineage(originalHeadSha, currentHeadSha);
    }
    if (!retainedCandidate && deps.candidateRoot) {
      const patch = changes.patchData ?? new TextEncoder().encode(changes.patch);
      const candidateFindings = outcomes.map((outcome) => {
        const thread = threads.find((item) => item.id === outcome.threadId)!;
        const sourceComment = thread.comments.find((comment) => !isGeneratedReviewReply(comment, thread.id));
        return {
          findingId: outcome.threadId,
          originalContentDigest: reviewThreadContentDigest(thread),
          proposedOutcome: outcome.outcome,
          summary: outcome.summary,
          evidence: outcome.evidence,
          reproduction: outcome.followUp ?? "",
          affectedFiles: [thread.path],
          source: {
            reviewer: sourceComment?.author ?? "unknown",
            commentId: sourceComment?.id ?? thread.id,
            commentUrl: sourceComment?.url ?? request.pullRequestUrl,
            reviewIds: thread.reviewIds ?? authorized.reviews.map((review) => review.id),
          },
          ...(outcome.repairIdentity ? { repairIdentity: outcome.repairIdentity } : {}),
        };
      });
      const fixGroups = normalizeReviewFixGroups(request.fixGroups, candidateFindings.map((finding) => finding.findingId));
      const candidateProvenance = {
        taskId: request.provenance?.taskId ?? `run:${runId}`,
        runId,
        actor:
          request.provenance?.actor
          ?? (request.ownership?.mode === "explicit-handoff"
            ? request.ownership.fromOwnerId
            : request.ownership?.ownerId)
          ?? UNATTRIBUTED_REVIEW_ACTOR,
      };
      retainedCandidate = createReviewCandidate({
        candidateId: runId,
        authorizedBaseRef: `refs/heads/${authorized.pullRequest.baseBranch}`,
        authorizedBaseSha: authorized.pullRequest.baseSha,
        authorizedHeadRef: `refs/pull/${authorized.pullRequest.number}/head`,
        authorizedHeadSha: authorized.pullRequest.headSha,
        resultingTreeSha: changes.resultingTreeSha ?? "",
        patch,
        changedFiles: changes.changedFiles,
        findings: candidateFindings.map((finding) => ({
          ...finding,
          fixGroupId: fixGroups.find((group) => group.findingIds.includes(finding.findingId))!.groupId,
        })),
        fixGroups,
        provenance: candidateProvenance,
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
      ...(followUpIntegrationDetected ? {
        verificationBaseSha: originalHeadSha,
        verificationHeadSha: currentHeadSha,
      } : {}),
    };
    let checksDigest = computeReviewChecksDigest(checks);
    const verificationRecordsByFinding = new Map<string, ReviewFindingVerificationRecord>();
    if (retainedCandidate && deps.candidateRoot && deps.verificationStore && deps.findingVerifier) {
      const tokens = [];
      for (const finding of retainedCandidate.findings) {
        const findingDigest = finding.originalContentDigest;
        if (!findingDigest) continue;
        const existingToken = retainedCandidate.verificationRecords.find((token) =>
          token.findingId === finding.findingId && token.checksDigest === checksDigest,
        );
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
        const token = retainedCandidate.verificationRecords.find((item) =>
          item.findingId === finding.findingId && item.checksDigest === checksDigest,
        );
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
    let resolvedByThread = new Map(
      resolvedOutcomes?.map((item) => [item.threadId, item]) ?? [],
    );
    let effectiveOutcomes = new Map(
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
      const finding = retainedCandidate?.findings.find((item) => item.findingId === outcome.threadId);
      return {
        threadId: outcome.threadId,
        ...(finding?.source ? { source: structuredClone(finding.source) } : {}),
        ...(finding?.fixGroupId ? { fixGroupId: finding.fixGroupId } : {}),
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
    if (deliveryMode === "commit" || deliveryMode === "follow-up-pr") {
      const retainedCandidateOwnerId =
        retainedCandidate.provenance?.actor === UNATTRIBUTED_REVIEW_ACTOR
          ? undefined
          : retainedCandidate.provenance?.actor;
      const taskOwnerId =
        retainedCandidateOwnerId
        ?? request.provenance?.actor
        ?? (request.ownership?.mode === "explicit-handoff"
          ? request.ownership.fromOwnerId
          : request.ownership?.ownerId)
        ?? UNATTRIBUTED_REVIEW_ACTOR;
      assertReviewOwnership(request.ownership, deliveryMode, taskOwnerId);
    }
    const selectedFindingIds = new Set(expectedThreadIds);
    const candidateGroups = retainedCandidate.fixGroups ?? [{
      groupId: "candidate",
      findingIds: retainedCandidate.findings.map((finding) => finding.findingId),
    }];
    const selectedGroups = candidateGroups.filter((group) =>
      group.findingIds.some((findingId) => selectedFindingIds.has(findingId)),
    );
    if (
      selectedGroups.length !== 1
      || selectedGroups.some((group) =>
        group.findingIds.some((findingId) => !selectedFindingIds.has(findingId)),
      )
    ) {
      throw new Error("independent review fix groups require separately scoped candidates");
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
      selectedFindingIds: [...selectedFindingIds],
      deliveryMode,
      owner: authorized.pullRequest.owner,
      repo: authorized.pullRequest.repo,
      pullRequestNumber: ref.number,
      baseBranch: authorized.pullRequest.baseBranch,
      baseSha: authorized.pullRequest.baseSha,
      headBranch: authorized.pullRequest.headBranch,
      authorizedHeadSha: originalHeadSha,
      ...(request.ownership ? { ownership: structuredClone(request.ownership) } : {}),
      ...(deliveryMode === "follow-up-pr"
        ? {
            followUpBaseBranch: authorized.pullRequest.headBranch,
            followUpBaseSha: followUpBaseSha!,
          }
        : {}),
    };
    const authorizedDeliveryPlan = await effectJournal.ensureDeliveryPlan(deliveryPlan);
    if (authorizedDeliveryPlan.selectedFindingIds === undefined) {
      const retainedFindingIds = new Set(retainedCandidate.findings.map((finding) => finding.findingId));
      const selectedFindingIds = new Set(expectedThreadIds);
      if (
        retainedFindingIds.size !== selectedFindingIds.size
        || [...retainedFindingIds].some((findingId) => !selectedFindingIds.has(findingId))
      ) {
        throw new Error("legacy delivery plan cannot authorize a narrowed finding scope");
      }
    }


    let publishableOutcomes = outcomes
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
    if (followUpIntegrationDetected) {
      phase = receipt.phase = "publish";
      await emitProgress();
      await revalidateRemoteReviewState(authorized, ref.number, currentHeadSha);
      if (!confirmedFollowUpCommitSha || !confirmedFollowUpPullRequestUrl) {
        throw new Error("follow-up integration requires a confirmed delivered candidate");
      }
      receipt.commitSha = confirmedFollowUpCommitSha;
      receipt.followUpPullRequestUrl = confirmedFollowUpPullRequestUrl;
      receipt.resultingHeadSha = currentHeadSha;
      receipt.lifecycle = "integrated";
      const integration = await verifyIntegratedReviewHead({
        authorized,
        deps,
        headSha: currentHeadSha,
        command: request.verifyCommand,
        timeoutMs: request.timeoutMinutes * 60_000,
      });
      receipt.integrationVerification = {
        baseSha: originalHeadSha,
        headSha: currentHeadSha,
        command: request.verifyCommand,
        exitCode: integration.exitCode ?? null,
        passed: integration.exitCode === 0,
        ...(integration.stdout ? { stdoutTail: redactSecrets(truncateTail(integration.stdout)) } : {}),
        ...(integration.stderr ? { stderrTail: redactSecrets(truncateTail(integration.stderr)) } : {}),
      };
      if (integration.exitCode !== 0) throw new Error("post-integration verification failed");
      const integrated = await verifyIntegratedReviewFindings({
        authorized,
        deps,
        candidate: retainedCandidate,
        findingIds: expectedThreadIds,
        baseSha: originalHeadSha,
        headSha: currentHeadSha,
        command: request.verifyCommand,
        wholeCheck: integration,
      });
      checksDigest = integrated.checksDigest;
      verificationRecordsByFinding.clear();
      for (const [findingId, record] of integrated.recordsByFinding) {
        verificationRecordsByFinding.set(findingId, record);
      }
      if (deps.verificationStore) {
        const findings = Object.fromEntries(retainedCandidate.findings.map((finding) => {
          const token = retainedCandidate.verificationRecords.find((item) =>
            item.findingId === finding.findingId && item.checksDigest === checksDigest,
          );
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
      resolvedByThread = new Map(
        resolvedOutcomes?.map((item) => [item.threadId, item]) ?? [],
      );
      effectiveOutcomes = new Map(
        outcomes.map((outcome) => {
          const resolved = resolvedByThread.get(outcome.threadId);
          const disposition = resolved?.verified.disposition;
          if (!resolved || resolved.verified.status === "pending" || disposition === "pending") {
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
      publishableOutcomes = outcomes
        .map((outcome) => {
          const resolved = resolvedByThread.get(outcome.threadId);
          return resolved?.verified.status === "verified"
            || resolved?.verified.status === "not-required"
            ? effectiveOutcomes.get(outcome.threadId)
            : undefined;
        })
        .filter((outcome): outcome is ReviewOutcome => outcome !== undefined);
      if (publishableOutcomes.length !== outcomes.length) {
        throw new Error("integrated review requires host-verified outcomes for every selected finding");
      }
      for (const result of receipt.threadResults) {
        const resolved = resolvedByThread.get(result.threadId);
        if (resolved) {
          result.verifiedDisposition = resolved.verified.disposition;
          result.verificationStatus = resolved.verified.status;
          result.verificationReason = resolved.verified.reason;
          result.verificationRecordId = resolved.verified.recordId;
        }
      }
      receipt.lifecycle = "verified";
      for (const result of receipt.threadResults) {
        result.fixCommitSha = receipt.commitSha;
      }
      await emitProgress();
    } else if (deliveryMode === "commit") {
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
      if (
        changes.changedFiles.length > 0
        && (remoteHead === originalHeadSha || remoteHead === confirmedCommitSha || remoteHead === confirmedPushSha)
      ) {
        phase = receipt.phase = "publish";
        await emitProgress();
        const commitEffectId = `${operationId}:commit`;
        const priorCommitEffect = effects.find((effect) => effect.effectId === commitEffectId);
        if (!priorCommitEffect) {
          await workspace.assertRunIdentity(originalHeadSha, authorized.pullRequest.headBranch);
        }
        const commitIntent = await effectJournal.beginEffect({
          effectId: commitEffectId,
          kind: "commit",
          idempotencyKey: commitEffectId,
        });
        if (priorCommitEffect) {
          if (commitIntent.status !== "confirmed" || !commitIntent.commitSha) {
            throw new Error("review commit effect requires reconciliation");
          }
          if (confirmedPushSha) {
            receipt.commitSha = commitIntent.commitSha;
          } else {
            if (!workspace.restoreCommittedReview) {
              throw new Error("confirmed commit requires workspace commit reconciliation");
            }
            receipt.commitSha = await workspace.restoreCommittedReview({
              commitSha: commitIntent.commitSha,
              branch: authorized.pullRequest.headBranch,
              baseSha: originalHeadSha,
              expectedTreeSha: retainedCandidate.resultingTreeSha,
              message: `fix: address review feedback (#${authorized.pullRequest.number})`,
            });
            if (receipt.commitSha !== commitIntent.commitSha) {
              await effectJournal.ackEffect({
                effectId: commitEffectId,
                commitSha: receipt.commitSha,
              });
            }
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
        await revalidateRemoteReviewState(
          authorized,
          ref.number,
          [originalHeadSha, receipt.commitSha].filter(
            (head): head is string => Boolean(head),
          ),
        );
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
        const pushedHead = await authorized.repositoryClient.getBranchSha(authorized.pullRequest.headBranch);
        if (pushedHead !== receipt.commitSha) throw new Error("pushed pull request head does not match the generated commit");
        if (!receipt.commitSha) throw new Error("direct review publication did not produce a commit");
        if (!workspace.assertCommitIncluded) {
          throw new Error("direct review publication lacks commit inclusion proof");
        }
        await workspace.assertCommitIncluded(receipt.commitSha, pushedHead);
        receipt.lifecycle = "integrated";
        const integration = await verifyIntegratedReviewHead({
          authorized,
          deps,
          headSha: pushedHead,
          command: request.verifyCommand,
          timeoutMs: request.timeoutMinutes * 60_000,
        });
        receipt.integrationVerification = {
          baseSha: originalHeadSha,
          headSha: pushedHead,
          command: request.verifyCommand,
          exitCode: integration.exitCode ?? null,
          passed: integration.exitCode === 0,
          ...(integration.stdout ? { stdoutTail: redactSecrets(truncateTail(integration.stdout)) } : {}),
          ...(integration.stderr ? { stderrTail: redactSecrets(truncateTail(integration.stderr)) } : {}),
        };
        if (integration.exitCode !== 0) throw new Error("post-integration verification failed");
        const integrated = await verifyIntegratedReviewFindings({
          authorized,
          deps,
          candidate: retainedCandidate,
          findingIds: expectedThreadIds,
          baseSha: originalHeadSha,
          headSha: pushedHead,
          command: request.verifyCommand,
          wholeCheck: integration,
        });
        checksDigest = integrated.checksDigest;
        verificationRecordsByFinding.clear();
        for (const [findingId, record] of integrated.recordsByFinding) {
          verificationRecordsByFinding.set(findingId, record);
        }
        if (deps.verificationStore) {
          const findings = Object.fromEntries(retainedCandidate.findings.map((finding) => {
            const token = retainedCandidate.verificationRecords.find((item) =>
              item.findingId === finding.findingId && item.checksDigest === checksDigest,
            );
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
        resolvedByThread = new Map(
          resolvedOutcomes?.map((item) => [item.threadId, item]) ?? [],
        );
        effectiveOutcomes = new Map(
          outcomes.map((outcome) => {
            const resolved = resolvedByThread.get(outcome.threadId);
            const disposition = resolved?.verified.disposition;
            if (!resolved || resolved.verified.status === "pending" || disposition === "pending") {
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
        publishableOutcomes = outcomes
          .map((outcome) => {
            const resolved = resolvedByThread.get(outcome.threadId);
            return resolved?.verified.status === "verified"
              || resolved?.verified.status === "not-required"
              ? effectiveOutcomes.get(outcome.threadId)
              : undefined;
          })
          .filter((outcome): outcome is ReviewOutcome => outcome !== undefined);
        if (publishableOutcomes.length !== outcomes.length) {
          throw new Error("integrated review requires host-verified outcomes for every selected finding");
        }
        for (const result of receipt.threadResults) {
          const resolved = resolvedByThread.get(result.threadId);
          if (resolved) {
            result.verifiedDisposition = resolved.verified.disposition;
            result.verificationStatus = resolved.verified.status;
            if (resolved.verified.reason) result.verificationReason = resolved.verified.reason;
            if (resolved.verified.recordId) result.verificationRecordId = resolved.verified.recordId;
          }
        }
        receipt.resultingHeadSha = pushedHead;
        receipt.lifecycle = "verified";
        for (const result of receipt.threadResults) {
          result.fixCommitSha = receipt.commitSha;
        }
        await emitProgress();
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
      const confirmedFollowUpPushSha = effects.find(
        (effect) =>
          effect.effectId === `${operationId}:follow-up-push`
          && effect.kind === "push"
          && effect.status === "confirmed"
          && effect.commitSha,
      )?.commitSha;
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
        if (confirmedFollowUpPushSha) {
          followUpCommitSha = commitIntent.commitSha;
        } else {
          if (!workspace.restoreCommittedReview) {
            throw new Error("confirmed follow-up commit requires workspace commit reconciliation");
          }
          followUpCommitSha = await workspace.restoreCommittedReview({
            commitSha: commitIntent.commitSha,
            branch: followUpBranch,
            baseSha: selectedFollowUpBaseSha,
            expectedTreeSha: retainedCandidate.resultingTreeSha,
            message: `fix: carry review candidate ${retainedCandidate.candidateId}`,
          });
          if (followUpCommitSha !== commitIntent.commitSha) {
            await effectJournal.ackEffect({
              effectId: commitEffectId,
              commitSha: followUpCommitSha,
            });
          }
        }
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
            baseBranch: authorized.pullRequest.headBranch,
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
      receipt.lifecycle = "delivered";
      for (const result of receipt.threadResults) {
        result.fixCommitSha = followUpCommitSha;
      }
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
      const currentExpectedHead = receipt.resultingHeadSha ?? receipt.commitSha ?? originalHeadSha;
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
        await revalidateRemoteReviewState(authorized, ref.number, currentExpectedHead);
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
    || current.baseBranch !== authorized.pullRequest.headBranch
    || current.baseSha !== authorized.pullRequest.headSha
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
  const source = thread.comments.find((comment) => !isGeneratedReviewReply(comment, thread.id))?.body ?? "Original review comment";
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

async function verifyIntegratedReviewFindings(input: {
  authorized: AuthorizedPullRequest;
  deps: ReviewPipelineDependencies;
  candidate: ReviewCandidate;
  findingIds: readonly string[];
  baseSha: string;
  headSha: string;
  command: string;
  wholeCheck: { exitCode?: number | null };
}): Promise<{
  checksDigest: string;
  recordsByFinding: Map<string, ReviewFindingVerificationRecord>;
}> {
  if (!input.deps.candidateRoot || !input.deps.verificationStore || !input.deps.findingVerifier) {
    throw new Error("integrated review requires durable host finding verification");
  }
  const checks = {
    command: input.command,
    exitCode: input.wholeCheck.exitCode ?? null,
    passed: input.wholeCheck.exitCode === 0,
    requiredChecks: input.wholeCheck.exitCode === 0 ? "passed" as const : "failed" as const,
    verificationBaseSha: input.baseSha,
    verificationHeadSha: input.headSha,
  };
  const checksDigest = computeReviewChecksDigest(checks);
  const recordsByFinding = new Map<string, ReviewFindingVerificationRecord>();
  const integrationWorkspace = await input.deps.createWorkspace();
  try {
    await input.authorized.withInstallationToken((token) =>
      integrationWorkspace.clonePullRequest({
        owner: input.authorized.pullRequest.owner,
        repo: input.authorized.pullRequest.repo,
        headBranch: input.authorized.pullRequest.headBranch,
        headSha: input.headSha,
        token,
      }),
    );
    await integrationWorkspace.prepareForAgent();
    const tokens = input.candidate.verificationRecords.filter((token) => token.checksDigest !== checksDigest);
    for (const findingId of input.findingIds) {
      const finding = input.candidate.findings.find((item) => item.findingId === findingId);
      const findingDigest = finding?.originalContentDigest;
      if (!finding || !findingDigest) continue;
      const existingToken = input.candidate.verificationRecords.find((token) =>
        token.findingId === findingId && token.checksDigest === checksDigest,
      );
      let record = existingToken
        ? await input.deps.verificationStore.lookup({
          recordId: existingToken.recordId,
          candidateDigest: input.candidate.candidateDigest,
          findingId,
          findingDigest,
          checksDigest,
        })
        : undefined;
      if (!record) {
        const proposed = await input.deps.findingVerifier.verify({
          candidate: input.candidate,
          findingId,
          workspace: integrationWorkspace,
          checks,
        });
        if (proposed) {
          if (
            proposed.candidateDigest !== input.candidate.candidateDigest
            || proposed.checksDigest !== checksDigest
            || (proposed.verificationBaseSha !== undefined && proposed.verificationBaseSha !== input.baseSha)
            || (proposed.verificationHeadSha !== undefined && proposed.verificationHeadSha !== input.headSha)
          ) {
            throw new Error(`integrated host verification record binding mismatch: ${findingId}`);
          }
          await input.deps.verificationStore.put(proposed);
          record = await input.deps.verificationStore.lookup({
            recordId: proposed.recordId,
            candidateDigest: input.candidate.candidateDigest,
            findingId,
            findingDigest,
            checksDigest,
          });
        }
      }
      if (record) {
        try {
          tokens.push(createReviewEvidenceToken(record));
          recordsByFinding.set(findingId, record);
        } catch {
          // A malformed or pending host record remains unresolved.
        }
      }
    }
    input.candidate.verificationRecords = tokens;
    await writeReviewCandidate(
      reviewCandidatePath(input.deps.candidateRoot, input.candidate.candidateId),
      input.candidate,
    );
    return { checksDigest, recordsByFinding };
  } finally {
    await integrationWorkspace.destroy();
  }
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

function assertReviewScope(
  scope: ReviewScope | undefined,
  authorized: AuthorizedPullRequest,
  originalHeadSha: string,
  selectedThreads: readonly ReviewThread[],
): void {
  if (!scope) return;
  if (scope.findingIds.length === 0) throw new Error("review scope must select at least one finding");
  if (new Set(scope.findingIds).size !== scope.findingIds.length) {
    throw new Error("review scope finding IDs must be unique");
  }
  if (scope.mode === "this-review") {
    if (!scope.reviewId || !authorized.reviews.some((review) => review.id === scope.reviewId)) {
      throw new Error("review scope review identifier is not authorized");
    }
    for (const findingId of scope.findingIds) {
      const thread = selectedThreads.find((candidate) => candidate.id === findingId);
      if (!thread) throw new Error(`review scope finding is not selected: ${findingId}`);
      if (thread.reviewIds === undefined) {
        throw new Error(`review scope thread review membership is unavailable: ${findingId}`);
      }
      if (!thread.reviewIds.includes(scope.reviewId)) {
        throw new Error(`review scope finding is not from review ${scope.reviewId}: ${findingId}`);
      }
    }
    if (scope.headSha !== undefined) throw new Error("this-review scope cannot include a head SHA");
  } else if (scope.mode === "all-current-findings") {
    if (!scope.headSha || !/^[0-9a-f]{40}$/.test(scope.headSha) || scope.headSha !== originalHeadSha) {
      throw new Error("review scope head SHA is not the authorized current head");
    }
    if (scope.reviewId !== undefined) throw new Error("all-current-findings scope cannot include a review identifier");
  } else {
    throw new Error("review scope mode is invalid");
  }
}

async function observeReviewBaseFreshness(
  authorized: AuthorizedPullRequest,
): Promise<ReviewBaseFreshness> {
  try {
    const observedBaseSha = await authorized.repositoryClient.getBranchSha(
      authorized.pullRequest.baseBranch,
    );
    if (!/^[0-9a-f]{40}$/.test(observedBaseSha)) {
      return {
        baseBranch: authorized.pullRequest.baseBranch,
        authorizedBaseSha: authorized.pullRequest.baseSha,
        status: "unavailable",
        integrationOwner: "original-pr-owner",
      };
    }
    return {
      baseBranch: authorized.pullRequest.baseBranch,
      authorizedBaseSha: authorized.pullRequest.baseSha,
      observedBaseSha,
      status: observedBaseSha === authorized.pullRequest.baseSha ? "fresh" : "stale",
      integrationOwner: "original-pr-owner",
    };
  } catch {
    return {
      baseBranch: authorized.pullRequest.baseBranch,
      authorizedBaseSha: authorized.pullRequest.baseSha,
      status: "unavailable",
      integrationOwner: "original-pr-owner",
    };
  }
}

function normalizeReviewFixGroups(
  input: readonly ReviewFixGroup[] | undefined,
  findingIds: readonly string[],
): ReviewFixGroup[] {
  if (!input) {
    return findingIds.map((findingId) => ({
      groupId: findingId,
      findingIds: [findingId],
    }));
  }
  const known = new Set(findingIds);
  const assigned = new Set<string>();
  const groups = input.map((group) => ({
    groupId: group.groupId,
    findingIds: [...group.findingIds],
  }));
  for (const group of groups) {
    if (!group.groupId.trim() || group.findingIds.length === 0) {
      throw new Error("review fix groups must have bounded non-empty identifiers");
    }
    for (const findingId of group.findingIds) {
      if (!known.has(findingId) || assigned.has(findingId)) {
        throw new Error(`review fix groups do not partition selected findings: ${findingId}`);
      }
      assigned.add(findingId);
    }
  }
  if (assigned.size !== known.size) throw new Error("review fix groups must cover selected findings");
  return groups;
}

function assertReviewOwnership(
  ownership: ReviewOwnershipAuthorization | undefined,
  deliveryMode: ReviewDeliveryMode,
  taskOwnerId: string,
): void {
  if (!ownership) throw new Error(`${deliveryMode} delivery requires explicit review ownership authorization`);
  if (deliveryMode === "commit" && ownership.mode !== "explicit-handoff") {
    throw new Error("direct review commit requires an explicit ownership handoff");
  }
  if (ownership.mode === "local-owner") {
    if (ownership.ownerId.toLowerCase() !== taskOwnerId.toLowerCase()) {
      throw new Error("review ownership does not match the host task owner");
    }
  } else if (ownership.fromOwnerId.toLowerCase() !== taskOwnerId.toLowerCase()) {
    throw new Error("review handoff source does not match the host task owner");
  }
}

async function verifyIntegratedReviewHead(input: {
  authorized: AuthorizedPullRequest;
  deps: ReviewPipelineDependencies;
  headSha: string;
  command: string;
  timeoutMs: number;
}): Promise<{ exitCode?: number | null; stdout?: string; stderr?: string }> {
  const integrationWorkspace = await input.deps.createWorkspace();
  try {
    await input.authorized.withInstallationToken((token) =>
      integrationWorkspace.clonePullRequest({
        owner: input.authorized.pullRequest.owner,
        repo: input.authorized.pullRequest.repo,
        headBranch: input.authorized.pullRequest.headBranch,
        headSha: input.headSha,
        token,
      }),
    );
    await integrationWorkspace.prepareForAgent();
    return await integrationWorkspace.verify(input.command, input.timeoutMs);
  } finally {
    await integrationWorkspace.destroy();
  }
}
