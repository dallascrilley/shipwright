import { expect, test } from "bun:test";

import {
  assertReviewVerificationPlan,
  computeReviewVerificationContextDigest,
  computeReviewVerificationResultDigest,
  createReviewCandidate,
  type ReviewCandidate,
  type ReviewVerificationPlan,
  type ReviewVerificationPlanStore,
  type ReviewVerificationResult,
} from "../../src/pipeline/repair-candidate.js";
import { createHostReviewFindingVerifier } from "../../src/pipeline/review-verifier.js";
import type { ReviewWorkspacePort } from "../../src/pipeline/review-run.js";

const findingDigest = "d".repeat(64);
const candidateSha = "b".repeat(40);

function candidate(options: {
  noCode?: boolean;
  changedFiles?: string[];
  findings?: ReviewCandidate["findings"];
} = {}): ReviewCandidate {
  const noCode = options.noCode === true;
  const changedFiles = options.changedFiles ?? (noCode ? [] : ["src/a.ts"]);
  const findings = options.findings ?? [
    {
      findingId: "finding-1",
      originalContentDigest: findingDigest,
      proposedOutcome: "rejected",
      summary: "guard the input",
      evidence: "the input is unchecked",
      reproduction: "run the reproducer",
      affectedFiles: noCode ? [] : ["src/a.ts"],
    },
  ];
  return createReviewCandidate({
    candidateId: "candidate-1",
    authorizedBaseRef: "main",
    authorizedBaseSha: "a".repeat(40),
    authorizedHeadRef: "feature",
    authorizedHeadSha: candidateSha,
    resultingTreeSha: "c".repeat(40),
    patch: noCode
      ? new Uint8Array()
      : new TextEncoder().encode(`diff --git a/${changedFiles[0]} b/${changedFiles[0]}\n`),
    changedFiles,
    findings,
    verification: {
      command: "bun test",
      exitCode: 0,
      passed: true,
      requiredChecks: "passed",
    },
    deliveryMode: "patch",
    createdAt: "2026-08-20T00:00:00.000Z",
  });
}

function result(exitCode: number, stdout = "", stderr = ""): ReviewVerificationResult {
  return { exitCode, stdout, stderr };
}

function planFor(
  candidateValue: ReviewCandidate,
  observed: { baseline: ReviewVerificationResult; candidate: ReviewVerificationResult },
  overrides: Partial<ReviewVerificationPlan["independentReview"]> &
    Partial<Pick<ReviewVerificationPlan, "riskLevel" | "adjudicatedOutcome">> = {},
): ReviewVerificationPlan {
  const independentReview = {
    reviewerId: "reviewer-1",
    contextDigest: "",
    verdict: overrides.verdict ?? "pass",
    freshContext: overrides.freshContext ?? true,
  } as const;
  const plan: ReviewVerificationPlan = {
    schema: "shipwright-review-verification-plan/v1",
    planId: "plan-1",
    candidateDigest: candidateValue.candidateDigest,
    findingId: "finding-1",
    findingDigest,
    command: "node reproduce.mjs",
    timeoutMs: 30_000,
    reproduction: { kind: "behavioral", assertion: "The reported input produces the expected result." },
    baseline: {
      expectedExitCode: observed.baseline.exitCode!,
      resultDigest: computeReviewVerificationResultDigest(observed.baseline),
    },
    candidate: {
      expectedExitCode: observed.candidate.exitCode!,
      resultDigest: computeReviewVerificationResultDigest(observed.candidate),
    },
    adjudicatedOutcome: overrides.adjudicatedOutcome ?? "fixed",
    riskLevel: overrides.riskLevel ?? "standard",
    independentReview,
    createdAt: "2026-08-20T00:00:00.000Z",
  };
  plan.independentReview = {
    ...plan.independentReview,
    contextDigest: computeReviewVerificationContextDigest({
      candidateDigest: plan.candidateDigest,
      findingId: plan.findingId,
      findingDigest: plan.findingDigest,
      command: plan.command,
      timeoutMs: plan.timeoutMs,
      reproduction: plan.reproduction,
      baseline: plan.baseline,
      candidate: plan.candidate,
      adjudicatedOutcome: plan.adjudicatedOutcome,
      riskLevel: plan.riskLevel,
      reviewerId: plan.independentReview.reviewerId,
    }),
  };
  return plan;
}

function store(plans: ReviewVerificationPlan[]): ReviewVerificationPlanStore {
  return {
    async lookup(input) {
      return plans.find(
        (plan) =>
          plan.candidateDigest === input.candidateDigest &&
          plan.findingId === input.findingId &&
          plan.findingDigest === input.findingDigest,
      );
    },
    async put() {},
  };
}

function checks() {
  return {
    command: "bun test",
    exitCode: 0,
    passed: true,
    requiredChecks: "passed" as const,
  };
}
function workspace(
  verifyReviewPlan?: (
    input: Parameters<NonNullable<ReviewWorkspacePort["verifyReviewPlan"]>>[0],
  ) => ReturnType<NonNullable<ReviewWorkspacePort["verifyReviewPlan"]>>,
): ReviewWorkspacePort {
  return {
    clonePullRequest: async () => {},
    prepareForAgent: async () => {},
    prepareReviewArtifact: async () => {},
    readAndRemoveArtifact: async () => "",
    verify: async () => ({ exitCode: 0 }),
    ...(verifyReviewPlan ? { verifyReviewPlan } : {}),
    inspectChanges: async () => ({
      changedFiles: [],
      patch: "",
      patchBytes: 0,
      patchData: new Uint8Array(),
      resultingTreeSha: "c".repeat(40),
      changedBlobs: [],
    }),
    quiesce: async () => {},
    assertRunIdentity: async () => {},
    commit: async () => "c".repeat(40),
    push: async () => {},
    destroy: async () => {},
  };
}


test("does not issue a disposition when the host plan is absent", async () => {
  const value = candidate();
  const verifier = createHostReviewFindingVerifier(store([]));
  const record = await verifier.verify({
    candidate: value,
    findingId: "finding-1",
    workspace: workspace(),
    checks: checks(),
  });
  expect(record).toBeUndefined();
});

test("ignores the model proposal and fixes only a trusted matching plan", async () => {
  const value = candidate();
  const observed = {
    baseline: result(1, "baseline-failure"),
    candidate: result(0, "candidate-success"),
  };
  const plan = planFor(value, observed, { adjudicatedOutcome: "fixed" });
  const verifier = createHostReviewFindingVerifier(store([plan]));
  const record = await verifier.verify({
    candidate: value,
    findingId: "finding-1",
    workspace: workspace(async () => observed),
    checks: checks(),
  });
  expect(record).toMatchObject({
    observedOutcome: "fixed",
    independentVerdict: "pass",
    findingDigest,
    candidateDigest: value.candidateDigest,
  });
});

test("rejects integrated proof whose recorded baseline differs from the executed baseline", async () => {
  const value = candidate();
  const observed = { baseline: result(1), candidate: result(0) };
  const verifier = createHostReviewFindingVerifier(store([planFor(value, observed)]));
  const record = await verifier.verify({
    candidate: value,
    findingId: "finding-1",
    workspace: workspace(async () => observed),
    checks: {
      ...checks(),
      verificationBaseSha: "e".repeat(40),
      verificationHeadSha: "f".repeat(40),
    },
  });
  expect(record).toBeUndefined();
});

test("keeps a forged reviewer freshness claim pending", async () => {
  const value = candidate();
  const observed = {
    baseline: result(1, "baseline-failure"),
    candidate: result(0, "candidate-success"),
  };
  const plan = planFor(value, observed, { freshContext: false });
  const verifier = createHostReviewFindingVerifier(store([plan]));
  const record = await verifier.verify({
    candidate: value,
    findingId: "finding-1",
    workspace: workspace(async () => observed),
    checks: checks(),
  });
  expect(record).toMatchObject({ observedOutcome: "pending", independentVerdict: "pending" });
});

test("requires a fresh-context pass for high-risk closure", async () => {
  const value = candidate();
  const observed = {
    baseline: result(1, "baseline-failure"),
    candidate: result(0, "candidate-success"),
  };
  const plan = planFor(value, observed, { riskLevel: "high", freshContext: false });
  const verifier = createHostReviewFindingVerifier(store([plan]));
  const record = await verifier.verify({
    candidate: value,
    findingId: "finding-1",
    workspace: workspace(async () => observed),
    checks: checks(),
  });
  expect(record?.riskLevel).toBe("high");
  expect(record?.observedOutcome).toBe("pending");
});

test("does not trust expected results when host observation differs", async () => {
  const value = candidate();
  const planned = {
    baseline: result(1, "baseline-failure"),
    candidate: result(0, "candidate-success"),
  };
  const plan = planFor(value, planned);
  const verifier = createHostReviewFindingVerifier(store([plan]));
  const record = await verifier.verify({
    candidate: value,
    findingId: "finding-1",
    workspace: workspace(async () => ({
      baseline: result(0, "unexpected-pass"),
      candidate: planned.candidate,
    })),
    checks: checks(),
  });
  expect(record?.observedOutcome).toBe("pending");
});

test("accepts a trusted no-code rejection only for an unchanged candidate", async () => {
  const value = candidate({ noCode: true });
  const observed = {
    baseline: result(0, "baseline-pass"),
    candidate: result(0, "candidate-pass"),
  };
  const plan = planFor(value, observed, { adjudicatedOutcome: "rejected" });
  const verifier = createHostReviewFindingVerifier(store([plan]));
  const record = await verifier.verify({
    candidate: value,
    findingId: "finding-1",
    workspace: workspace(async () => observed),
    checks: checks(),
  });
  expect(record).toMatchObject({
    observedOutcome: "rejected",
    independentVerdict: "pass",
  });
});
test("scopes no-code verification to the current finding", async () => {
  const value = candidate({
    changedFiles: ["src/b.ts"],
    findings: [
      {
        findingId: "finding-1",
        originalContentDigest: findingDigest,
        proposedOutcome: "rejected",
        summary: "guard the input",
        evidence: "the input is unchecked",
        reproduction: "run the reproducer",
        affectedFiles: ["src/a.ts"],
      },
      {
        findingId: "finding-2",
        originalContentDigest: "e".repeat(64),
        proposedOutcome: "fixed",
        summary: "repair the output",
        evidence: "the output is malformed",
        reproduction: "run the output reproducer",
        affectedFiles: ["src/b.ts"],
      },
    ],
  });
  const observed = {
    baseline: result(0, "baseline-pass"),
    candidate: result(0, "candidate-pass"),
  };
  const plan = planFor(value, observed, { adjudicatedOutcome: "rejected" });
  const verifier = createHostReviewFindingVerifier(store([plan]));
  const record = await verifier.verify({
    candidate: value,
    findingId: "finding-1",
    workspace: workspace(async () => observed),
    checks: checks(),
  });
  expect(record).toMatchObject({
    observedOutcome: "rejected",
    independentVerdict: "pass",
  });
});


test("keeps a no-code rejection pending when the candidate contains a patch", async () => {
  const value = candidate();
  const observed = {
    baseline: result(0, "baseline-pass"),
    candidate: result(0, "candidate-pass"),
  };
  const plan = planFor(value, observed, { adjudicatedOutcome: "rejected" });
  const verifier = createHostReviewFindingVerifier(store([plan]));
  const record = await verifier.verify({
    candidate: value,
    findingId: "finding-1",
    workspace: workspace(async () => observed),
    checks: checks(),
  });
  expect(record).toMatchObject({
    observedOutcome: "pending",
    independentVerdict: "pending",
  });
});

test("rejects static-only verification commands for behavioral plans", () => {
  const value = candidate();
  const observed = {
    baseline: result(1, "baseline-failure"),
    candidate: result(0, "candidate-success"),
  };
  const plan = planFor(value, observed);
  plan.command = "bun run lint && echo done";
  expect(() => assertReviewVerificationPlan(plan)).toThrow("static-only checks");
});
