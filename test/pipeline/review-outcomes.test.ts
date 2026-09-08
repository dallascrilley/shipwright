import { expect, test } from "bun:test";
import { parseReviewOutcomes, resolveVerifiedReviewOutcomes } from "../../src/pipeline/review-outcomes.js";

const artifact = (threads: unknown[]) => JSON.stringify({ threads });

test("accepts exactly one justified outcome per authorized thread", () => {
  expect(parseReviewOutcomes(artifact([
    { threadId: "t1", outcome: "fixed", summary: "Added guard", evidence: "src/a.ts:4" },
    { threadId: "t2", outcome: "rejected", summary: "Already guarded", evidence: "src/b.ts:8" },
  ]), ["t1", "t2"], ["src/a.ts"])).toHaveLength(2);
});

test("rejects missing, duplicate, unknown, and unsupported no-code outcomes", () => {
  expect(() => parseReviewOutcomes(artifact([]), ["t1"])).toThrow("missing review threads");
  expect(() => parseReviewOutcomes(artifact([
    { threadId: "t1", outcome: "rejected", summary: "x", evidence: "y" },
    { threadId: "t1", outcome: "rejected", summary: "x", evidence: "y" },
  ]), ["t1"])).toThrow("duplicate review thread");
  expect(() => parseReviewOutcomes(artifact([
    { threadId: "other", outcome: "rejected", summary: "x", evidence: "y" },
  ]), ["t1"])).toThrow("unknown review thread");
  expect(() => parseReviewOutcomes(artifact([
    { threadId: "t1", outcome: "fixed", summary: "x", evidence: "y" },
  ]), ["t1"], [])).toThrow("require a repository change");
});

test("requires a concrete follow-up for deferred outcomes", () => {
  expect(() => parseReviewOutcomes(artifact([
    { threadId: "t1", outcome: "deferred", summary: "later", evidence: "out of scope" },
  ]), ["t1"])).toThrow("requires a follow-up");
});


test("keeps optional proposal identity metadata non-authoritative", () => {
  const digest = "a".repeat(64);
  const outcome = parseReviewOutcomes(artifact([
    {
      threadId: "t1",
      outcome: "fixed",
      summary: "Added guard",
      evidence: "src/a.ts:4",
      candidateId: "candidate-1",
      candidateDigest: digest,
      findingId: "finding-1",
      findingDigest: digest,
      checksDigest: digest,
      repairIdentity: "guard-repair",
    },
  ]), ["t1"], ["src/a.ts"]);
  expect(outcome[0]?.candidateDigest).toBe(digest);
  expect(() => parseReviewOutcomes(artifact([{
    threadId: "t1",
    outcome: "fixed",
    summary: "x",
    evidence: "y",
    risk: "high",
  }]), ["t1"], ["src/a.ts"])).toThrow();
});

test("requires storage-backed host proof bound to original finding and checks", async () => {
  const candidateDigest = "a".repeat(64);
  const findingContentDigest = "b".repeat(64);
  const checksDigest = "c".repeat(64);
  const outcome = parseReviewOutcomes(artifact([{
    threadId: "t1",
    outcome: "fixed",
    summary: "Added guard",
    evidence: "src/a.ts:4",
    findingId: "finding-1",
  }]), ["t1"], ["src/a.ts"]);
  const record = {
    schema: "shipwright-review-verification/v1" as const,
    recordId: "record-1",
    candidateDigest,
    findingId: "finding-1",
    findingDigest: findingContentDigest,
    checksDigest,
    observedOutcome: "fixed" as const,
    observedEvidence: "host check passed",
    observedReproduction: "host reproduction passed",
    observedAffectedFiles: ["src/a.ts"],
    requiredChecks: "passed" as const,
    riskLevel: "standard" as const,
    independentVerdict: "pass" as const,
    createdAt: new Date().toISOString(),
  };
  const calls: Array<Record<string, string>> = [];
  const store = {
    async lookup(input: { recordId: string; candidateDigest: string; findingId: string; findingDigest: string; checksDigest: string }) {
      calls.push(input);
      return input.recordId === "record-1" && input.candidateDigest === candidateDigest && input.findingDigest === findingContentDigest && input.checksDigest === checksDigest ? record : undefined;
    },
  };
  const resolved = await resolveVerifiedReviewOutcomes(outcome, {
    candidateDigest,
    checksDigest,
    findings: { t1: { recordId: "record-1", findingId: "finding-1", findingContentDigest } },
    store,
  });
  expect(resolved[0]?.proposed).toEqual(outcome[0]);
  expect(resolved[0]?.verified).toEqual({ disposition: "fixed", status: "verified", recordId: "record-1" });
  expect(calls).toEqual([{ recordId: "record-1", candidateDigest, findingId: "finding-1", findingDigest: findingContentDigest, checksDigest }]);

  const forgedStore = {
    async lookup() {
      return { ...record, candidateDigest: "d".repeat(64) };
    },
  };
  const forged = await resolveVerifiedReviewOutcomes(outcome, {
    candidateDigest,
    checksDigest,
    findings: { t1: { recordId: "record-1", findingId: "finding-1", findingContentDigest } },
    store: forgedStore,
  });
  expect(forged[0]?.verified).toEqual({ disposition: "pending", status: "pending", reason: "missing or forged host verification binding" });
});

test("never verifies a non-null forged host binding", async () => {
  const candidateDigest = "a".repeat(64);
  const findingContentDigest = "b".repeat(64);
  const checksDigest = "c".repeat(64);
  const outcome = parseReviewOutcomes(artifact([{
    threadId: "t1",
    outcome: "fixed",
    summary: "Added guard",
    evidence: "src/a.ts:4",
    findingId: "finding-1",
  }]), ["t1"], ["src/a.ts"]);
  const forgedRecord = {
    schema: "shipwright-review-verification/v1" as const,
    recordId: "record-forged",
    candidateDigest: "d".repeat(64),
    findingId: "forged-finding",
    findingDigest: "e".repeat(64),
    checksDigest: "f".repeat(64),
    observedOutcome: "fixed" as const,
    observedEvidence: "host check passed",
    observedReproduction: "host reproduction passed",
    observedAffectedFiles: ["src/a.ts"],
    requiredChecks: "passed" as const,
    riskLevel: "standard" as const,
    independentVerdict: "pass" as const,
    createdAt: new Date().toISOString(),
  };
  const resolved = await resolveVerifiedReviewOutcomes(outcome, {
    candidateDigest,
    checksDigest,
    findings: { t1: { recordId: "record-1", findingId: "finding-1", findingContentDigest } },
    store: { async lookup() { return forgedRecord; } },
  });
  expect(resolved).toHaveLength(1);
  expect(resolved.filter((item) => item.verified.status === "pending")).toHaveLength(1);
  expect(resolved.some((item) => item.verified.status === "verified")).toBe(false);
});

test("does not close on pending checks or unresolved high-risk independent verdicts", async () => {
  const candidateDigest = "a".repeat(64);
  const findingContentDigest = "b".repeat(64);
  const checksDigest = "c".repeat(64);
  const outcome = parseReviewOutcomes(artifact([{
    threadId: "t1", outcome: "fixed", summary: "fix", evidence: "host", findingId: "f1",
  }]), ["t1"], ["src/a.ts"]);
  const base = {
    schema: "shipwright-review-verification/v1" as const, recordId: "record-1", candidateDigest, findingId: "f1", findingDigest: findingContentDigest, checksDigest,
    observedOutcome: "fixed" as const, observedEvidence: "proof", observedReproduction: "repro", observedAffectedFiles: ["src/a.ts"], requiredChecks: "passed" as const, riskLevel: "standard" as const, independentVerdict: "pass" as const, createdAt: new Date().toISOString(),
  };
  const pending = await resolveVerifiedReviewOutcomes(outcome, {
    candidateDigest, checksDigest, findings: { t1: { recordId: "record-1", findingId: "f1", findingContentDigest } },
    store: { async lookup() { return { ...base, requiredChecks: "pending" as const }; } },
  });
  expect(pending[0]?.verified.disposition).toBe("pending");
  expect(pending[0]?.verified.reason).toBe("required checks are pending");

  const highRisk = await resolveVerifiedReviewOutcomes(outcome, {
    candidateDigest, checksDigest, findings: { t1: { recordId: "record-1", findingId: "f1", findingContentDigest } },
    store: { async lookup() { return { ...base, requiredChecks: "passed" as const, riskLevel: "high" as const, independentVerdict: "disputed" as const }; } },
  });
  expect(highRisk[0]?.verified.reason).toBe("independent verdict is disputed");
});

test("requires confirmed owned follow-up for high-risk deferred outcomes", async () => {
  const candidateDigest = "a".repeat(64);
  const findingContentDigest = "b".repeat(64);
  const checksDigest = "c".repeat(64);
  const outcomes = parseReviewOutcomes(artifact([{
    threadId: "t1", outcome: "deferred", summary: "later", evidence: "host", followUp: "https://github.com/acme/widgets/issues/123", findingId: "f1",
  }]), ["t1"]);
  const base = {
    schema: "shipwright-review-verification/v1" as const, recordId: "record-high", candidateDigest, findingId: "f1", findingDigest: findingContentDigest, checksDigest,
    observedOutcome: "deferred" as const, observedEvidence: "proof", observedReproduction: "repro", observedAffectedFiles: ["src/a.ts"], requiredChecks: "passed" as const, riskLevel: "high" as const, independentVerdict: "pass" as const, createdAt: new Date().toISOString(),
  };
  const binding = { candidateDigest, checksDigest, findings: { t1: { recordId: "record-high", findingId: "f1", findingContentDigest } } };
  const missing = await resolveVerifiedReviewOutcomes(outcomes, { ...binding, store: { async lookup() { return base; } } });
  expect(missing[0]?.verified.reason).toBe("deferred outcome lacks confirmed owned follow-up readback");
  const confirmed = await resolveVerifiedReviewOutcomes(outcomes, {
    ...binding,
    store: { async lookup() { return { ...base, followUp: { kind: "issue" as const, idempotencyKey: "issue-1", assignedTo: "security-owner", status: "confirmed" as const, repository: "acme/widgets", remoteId: "I_123", remoteUrl: "https://github.com/acme/widgets/issues/123" } }; } },
  });
  expect(confirmed[0]?.verified).toEqual({ disposition: "deferred", status: "verified", recordId: "record-high" });

  const standardDeferred = await resolveVerifiedReviewOutcomes(outcomes, {
    ...binding,
    store: { async lookup() { return { ...base, riskLevel: "standard" as const }; } },
  });
  expect(standardDeferred[0]?.verified.reason).toBe("deferred outcome lacks confirmed owned follow-up readback");

  const highRiskFixed = await resolveVerifiedReviewOutcomes(
    [{ ...outcomes[0]!, outcome: "fixed", followUp: undefined }],
    { ...binding, store: { async lookup() { return { ...base, observedOutcome: "fixed" as const }; } } },
  );
  expect(highRiskFixed[0]?.verified).toEqual({ disposition: "fixed", status: "verified", recordId: "record-high" });
});

test("returns already-addressed and needs-human without pretending they are fixed", async () => {
  const candidateDigest = "a".repeat(64);
  const findingContentDigest = "b".repeat(64);
  const checksDigest = "c".repeat(64);
  const outcomes = parseReviewOutcomes(artifact([
    { threadId: "t1", outcome: "rejected", summary: "stale", evidence: "host", findingId: "f1" },
    { threadId: "t2", outcome: "needs-human", summary: "unclear", evidence: "host" },
  ]), ["t1", "t2"]);
  const record = {
    schema: "shipwright-review-verification/v1" as const, recordId: "record-2", candidateDigest, findingId: "f1", findingDigest: findingContentDigest, checksDigest,
    observedOutcome: "already-addressed" as const, observedEvidence: "old guard", observedReproduction: "reproduced", observedAffectedFiles: ["src/a.ts"], requiredChecks: "passed" as const, riskLevel: "standard" as const, independentVerdict: "pass" as const, createdAt: new Date().toISOString(),
  };
  const resolved = await resolveVerifiedReviewOutcomes(outcomes, {
    candidateDigest, checksDigest, findings: { t1: { recordId: "record-2", findingId: "f1", findingContentDigest } },
    store: { async lookup(input) { return input.recordId === "record-2" ? record : undefined; } },
  });
  expect(resolved.map((item) => item.verified)).toEqual([
    { disposition: "already-addressed", status: "verified", recordId: "record-2" },
    { disposition: "needs-human", status: "not-required", reason: "model requested human review" },
  ]);
});
