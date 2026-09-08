import { createHash } from "node:crypto";

import {
  assertReviewVerificationPlan,
  computeReviewChecksDigest,
  computeReviewVerificationContextDigest,
  computeReviewVerificationResultDigest,
  reviewCandidatePatch,
  type ReviewCandidate,
  type ReviewFindingVerificationRecord,
  type ReviewVerificationPlan,
  type ReviewVerificationPlanStore,
  type ReviewVerificationResult,
} from "./repair-candidate.js";
import type { ReviewFindingVerifier, ReviewWorkspacePort } from "./review-run.js";

/**
 * Host-owned verifier. A model proposal can never mint a disposition. A
 * disposition exists only when an operator-imported, host-owned plan binds
 * the exact original finding digest to a reproduction command, expected
 * baseline/candidate observations, risk classification, and a fresh-context
 * independent reviewer verdict.
 */
export function createHostReviewFindingVerifier(
  plans?: ReviewVerificationPlanStore,
): ReviewFindingVerifier {
  return {
    async verify({ candidate, findingId, workspace, checks }) {
      const finding = candidate.findings.find((item) => item.findingId === findingId);
      const findingDigest = finding?.originalContentDigest;
      if (!finding || !findingDigest || !plans || !workspace.verifyReviewPlan) {
        return undefined;
      }

      const plan = await plans.lookup({
        candidateDigest: candidate.candidateDigest,
        findingId,
        findingDigest,
      });
      if (!plan) return undefined;
      try {
        assertReviewVerificationPlan(plan);
      } catch {
        return undefined;
      }
      if (
        plan.candidateDigest !== candidate.candidateDigest ||
        plan.findingId !== findingId ||
        plan.findingDigest !== findingDigest
      ) {
        return undefined;
      }

      let observed: { baseline: ReviewVerificationResult; candidate: ReviewVerificationResult };
      try {
        observed = await workspace.verifyReviewPlan({
          baselineSha: candidate.authorizedHeadSha,
          patch: reviewCandidatePatch(candidate),
          command: plan.command,
          timeoutMs: plan.timeoutMs,
        });
      } catch {
        return undefined;
      }

      return buildVerificationRecord(candidate, findingId, findingDigest, plan, observed, checks);
    },
  };
}

function buildVerificationRecord(
  candidate: ReviewCandidate,
  findingId: string,
  findingDigest: string,
  plan: ReviewVerificationPlan,
  observed: { baseline: ReviewVerificationResult; candidate: ReviewVerificationResult },
  checks: {
    command: string;
    exitCode: number | null;
    passed: boolean;
    requiredChecks: "passed" | "failed" | "pending";
  },
): ReviewFindingVerificationRecord {
  const baselineDigest = computeReviewVerificationResultDigest(observed.baseline);
  const candidateResultDigest = computeReviewVerificationResultDigest(observed.candidate);
  const exactObservationMatch =
    observed.baseline.exitCode === plan.baseline.expectedExitCode &&
    baselineDigest === plan.baseline.resultDigest &&
    observed.candidate.exitCode === plan.candidate.expectedExitCode &&
    candidateResultDigest === plan.candidate.resultDigest;
  const outcomeObservationMatch =
    plan.adjudicatedOutcome === "fixed"
      ? exactObservationMatch &&
        observed.baseline.exitCode !== 0 &&
        observed.candidate.exitCode === 0 &&
        candidate.patchBytes > 0 &&
        candidate.changedFiles.length > 0
      : plan.adjudicatedOutcome === "rejected" ||
          plan.adjudicatedOutcome === "already-addressed" ||
          plan.adjudicatedOutcome === "needs-human"
        ? exactObservationMatch &&
          observed.baseline.exitCode === 0 &&
          observed.candidate.exitCode === 0 &&
          candidate.patchBytes === 0 &&
          candidate.changedFiles.length === 0
        : plan.adjudicatedOutcome === "deferred"
          ? exactObservationMatch &&
            plan.followUp?.status === "confirmed" &&
            Boolean(plan.followUp.remoteId && plan.followUp.remoteUrl && plan.followUp.assignedTo)
          : false;
  const expectedContextDigest = computeReviewVerificationContextDigest({
    candidateDigest: plan.candidateDigest,
    findingId: plan.findingId,
    findingDigest: plan.findingDigest,
    command: plan.command,
    timeoutMs: plan.timeoutMs,
    baseline: plan.baseline,
    candidate: plan.candidate,
    adjudicatedOutcome: plan.adjudicatedOutcome,
    riskLevel: plan.riskLevel,
    reviewerId: plan.independentReview.reviewerId,
  });
  const reviewerPass =
    plan.independentReview.verdict === "pass" &&
    plan.independentReview.freshContext === true &&
    plan.independentReview.contextDigest === expectedContextDigest;
  const independentlyVerified =
    outcomeObservationMatch &&
    checks.passed &&
    checks.requiredChecks === "passed" &&
    reviewerPass;
  const recordId = `verification-${createHash("sha256")
    .update(`${candidate.candidateDigest}:${findingId}:${plan.planId}`)
    .digest("hex")
    .slice(0, 48)}`;

  return {
    schema: "shipwright-review-verification/v1",
    recordId,
    candidateDigest: candidate.candidateDigest,
    findingId,
    findingDigest,
    checksDigest: computeReviewChecksDigest(checks),
    observedOutcome: independentlyVerified ? plan.adjudicatedOutcome : "pending",
    observedEvidence: independentlyVerified
      ? `Trusted plan ${plan.planId} matched baseline ${baselineDigest} and candidate ${candidateResultDigest} results.`
      : `Trusted plan ${plan.planId} did not produce an independently verified disposition.`,
    observedReproduction: `Plan command ${plan.command}; baseline ${baselineDigest}; candidate ${candidateResultDigest}.`,
    observedAffectedFiles: [...candidate.changedFiles],
    requiredChecks: checks.requiredChecks,
    riskLevel: plan.riskLevel,
    independentVerdict: independentlyVerified
      ? "pass"
      : plan.independentReview.verdict === "pass"
        ? "pending"
        : plan.independentReview.verdict,
    ...(independentlyVerified && plan.followUp
      ? { followUp: structuredClone(plan.followUp) }
      : {}),
    createdAt: new Date().toISOString(),
  };
}
