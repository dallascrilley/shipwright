import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  FileReviewEffectJournalStore,
  FileReviewFindingVerificationStore,
  computeReviewChecksDigest,
  computeReviewFindingDigest,
  createReviewCandidate,
  createReviewEvidenceToken,
  purgeReviewArtifacts,
  readReviewCandidate,
  reviewCandidatePatch,
  reviewCandidatePath,
  writeReviewCandidate,
  type ReviewCandidate,
  type ReviewCandidateInput,
  type ReviewFindingVerificationRecord,
} from "../../src/pipeline/repair-candidate.js";

import { assertSecretSafeBytes } from "../../src/pipeline/secret-safety.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
function candidate(overrides: Partial<ReviewCandidateInput> = {}): ReviewCandidate {
  return createReviewCandidate({
    candidateId: "candidate-1",
    authorizedBaseRef: "refs/heads/main",
    authorizedBaseSha: BASE_SHA,
    authorizedHeadRef: "refs/pull/1/head",
    authorizedHeadSha: HEAD_SHA,
    resultingTreeSha: "c".repeat(40),
    patch: new Uint8Array([0, 255, 10, 13]),
    changedFiles: ["assets/icon.bin"],
    findings: [
      {
        findingId: "thread-1",
        proposedOutcome: "fixed",
        summary: "The finding has a retained repair candidate.",
        evidence: "The candidate carries the exact changed tree.",
        reproduction: "Run the focused verification command.",
        affectedFiles: ["assets/icon.bin"],
      },
    ],
    verification: {
      command: "bun test test/pipeline/repair-candidate.test.ts",
      exitCode: 0,
      passed: true,
      requiredChecks: "passed",
    },
    deliveryMode: "evidence-only",
    createdAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  });
}

function recordFor(value: ReviewCandidate): ReviewFindingVerificationRecord {
  const finding = value.findings[0]!;
  const checks = {
    command: value.verification.command,
    exitCode: value.verification.exitCode,
    passed: value.verification.passed,
    requiredChecks: value.verification.requiredChecks,
  } as const;
  return {
    schema: "shipwright-review-verification/v1",
    recordId: "record-1",
    candidateDigest: value.candidateDigest,
    findingId: finding.findingId,
    findingDigest: computeReviewFindingDigest(finding),
    checksDigest: computeReviewChecksDigest(checks),
    observedOutcome: "fixed",
    observedEvidence: "Host inspection observed the retained changed tree.",
    observedReproduction: "The focused host check passed against the candidate tree.",
    observedAffectedFiles: ["assets/icon.bin"],
    requiredChecks: "passed",
    riskLevel: "standard",
    independentVerdict: "pass",
    createdAt: "2026-07-21T00:00:01.000Z",
  };
}

describe("review candidate persistence", () => {
  test("blocks secret-shaped bytes even when surrounded by binary data", () => {
    const secret = new Uint8Array([
      0,
      255,
      ...new TextEncoder().encode(`ghs_${"x".repeat(32)}`),
      13,
    ]);
    expect(() => assertSecretSafeBytes(secret)).toThrow(
      "secret-shaped binary content",
    );
  });

  test("retains byte-exact binary patches and derives downloads from one manifest", async () => {
    const value = candidate();
    expect([...reviewCandidatePatch(value)]).toEqual([0, 255, 10, 13]);
    const root = await mkdtemp(join(tmpdir(), "shipwright-candidate-"));
    try {
      const path = reviewCandidatePath(root, value.candidateId);
      await writeReviewCandidate(path, value);
      await expect(readFile(`${path}.patch`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        candidateDigest: value.candidateDigest,
        patchBytes: 4,
      });
      await writeReviewCandidate(path, { ...value, effects: [{ effectId: "effect-1", kind: "commit", idempotencyKey: "commit-1", status: "intent" }] });
      expect(JSON.parse(await readFile(path, "utf8")).effects).toEqual([{ effectId: "effect-1", kind: "commit", idempotencyKey: "commit-1", status: "intent" }]);
      await expect(writeReviewCandidate(path, {
        ...value,
        effects: [{
          effectId: "effect-secret",
          kind: "push",
          idempotencyKey: "push-secret",
          status: "intent",
          detail: `ghs_${"x".repeat(32)}`,
        }],
      })).rejects.toThrow("secret-shaped");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("retains host source, shared fix groups, and immutable run provenance", () => {
    const source = {
      reviewer: "reviewer-1",
      commentId: "comment-1",
      commentUrl: "https://github.com/acme/widget/pull/1#discussion_r1",
      reviewIds: ["review-1"],
    };
    const value = candidate({
      findings: [
        {
          findingId: "thread-1",
          proposedOutcome: "fixed",
          summary: "One duplicate finding.",
          evidence: "The shared repair covers this finding.",
          reproduction: "Run the focused verification command.",
          affectedFiles: ["assets/icon.bin"],
          source,
          fixGroupId: "shared-repair",
        },
        {
          findingId: "thread-2",
          proposedOutcome: "fixed",
          summary: "Another duplicate finding.",
          evidence: "The shared repair covers this finding too.",
          reproduction: "Run the focused verification command.",
          affectedFiles: ["assets/icon.bin"],
          source: { ...source, commentId: "comment-2" },
          fixGroupId: "shared-repair",
        },
      ],
      fixGroups: [{ groupId: "shared-repair", findingIds: ["thread-1", "thread-2"] }],
      provenance: { taskId: "WKS-2245", runId: "run-1", actor: "operator" },
    });
    expect(value.fixGroups).toEqual([
      { groupId: "shared-repair", findingIds: ["thread-1", "thread-2"] },
    ]);
    expect(value.findings.map((finding) => finding.source?.commentId)).toEqual([
      "comment-1",
      "comment-2",
    ]);
    expect(value.provenance).toEqual({
      taskId: "WKS-2245",
      runId: "run-1",
      actor: "operator",
    });
    expect(candidate({
      ...value,
      provenance: { ...value.provenance!, actor: "different-actor" },
    }).candidateDigest).not.toBe(value.candidateDigest);
  });

  test("rejects candidate path traversal and binds proof lookup to the opaque record id", async () => {
    expect(() => reviewCandidatePath("/tmp", "../outside")).toThrow(/identifier-safe/);
    const value = candidate();
    const root = await mkdtemp(join(tmpdir(), "shipwright-verification-"));
    try {
      const store = await FileReviewFindingVerificationStore.open(root);
      const record = recordFor(value);
      await store.put(record);
      const token = createReviewEvidenceToken(record);
      await expect(store.lookup({ ...token, recordId: "record-2" })).resolves.toBeUndefined();
      await expect(store.lookup(token)).resolves.toEqual(record);
      await expect(store.put({ ...record, observedEvidence: "different host evidence" })).rejects.toThrow("immutable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("review effect journal", () => {
  test("persists the next state before updating memory and retries after a failed write", async () => {
    const value = candidate();
    const root = await mkdtemp(join(tmpdir(), "shipwright-effects-"));
    const path = join(root, "effects.json");
    try {
      const journal = await FileReviewEffectJournalStore.open(path, value);
      await mkdir(path);
      await expect(journal.beginEffect({ effectId: "effect-1", kind: "push", idempotencyKey: "push-1" })).rejects.toBeDefined();
      await rm(path, { recursive: true, force: true });
      const intent = await journal.beginEffect({ effectId: "effect-1", kind: "push", idempotencyKey: "push-1" });
      expect(intent.status).toBe("intent");
      expect(JSON.parse(await readFile(path, "utf8")).effects).toEqual([intent]);
      await expect(journal.ackEffect({
        effectId: "effect-1",
        detail: `authorization ghs_${"x".repeat(32)}`,
      })).rejects.toThrow("secret-shaped");
      await expect(journal.load()).resolves.toMatchObject([
        { effectId: "effect-1", status: "intent" },
      ]);
      const reopened = await FileReviewEffectJournalStore.open(path, value);
      await reopened.ackEffect({ effectId: "effect-1", commitSha: "d".repeat(40) });
      await expect(journal.load()).resolves.toMatchObject([{ status: "confirmed", commitSha: "d".repeat(40) }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serializes two store instances and preserves both intents", async () => {
    const value = candidate();
    const root = await mkdtemp(join(tmpdir(), "shipwright-effects-race-"));
    const path = join(root, "effects.json");
    try {
      const first = await FileReviewEffectJournalStore.open(path, value);
      const second = await FileReviewEffectJournalStore.open(path, value);
      await Promise.all([
        first.beginEffect({ effectId: "effect-a", kind: "reply", idempotencyKey: "reply-a" }),
        second.beginEffect({ effectId: "effect-b", kind: "resolve", idempotencyKey: "resolve-b" }),
      ]);
      const effects = await first.load();
      expect(effects.sort((left, right) => left.effectId.localeCompare(right.effectId))).toEqual([
        { effectId: "effect-a", kind: "reply", idempotencyKey: "reply-a", status: "intent" },
        { effectId: "effect-b", kind: "resolve", idempotencyKey: "resolve-b", status: "intent" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  test("rejects malformed effects and delivery-plan drift after an intent", async () => {
    const value = candidate();
    const root = await mkdtemp(join(tmpdir(), "shipwright-effects-contract-"));
    const path = join(root, "effects.json");
    const plan = {
      candidateDigest: value.candidateDigest,
      deliveryMode: "commit" as const,
      owner: "octo-org",
      repo: "shipwright",
      pullRequestNumber: 1,
      baseBranch: "main",
      baseSha: BASE_SHA,
      headBranch: "repair/1",
      authorizedHeadSha: HEAD_SHA,
      ownership: {
        mode: "explicit-handoff" as const,
        ownerId: "shipwright",
        fromOwnerId: "octo-org",
        handoffId: "handoff-1",
        authorizedBy: "operator",
        source: "operator" as const,
      },
    };
    try {
      const journal = await FileReviewEffectJournalStore.open(path, value);
      await journal.ensureDeliveryPlan(plan);
      await journal.beginEffect({ effectId: "effect-1", kind: "commit", idempotencyKey: "commit-1" });
      await expect(journal.ensureDeliveryPlan({
        ...plan,
        deliveryMode: "follow-up-pr",
        followUpBaseBranch: "feature",
        followUpBaseSha: HEAD_SHA,
      })).rejects.toThrow("changed after authorization");

      const malformedPath = join(root, "malformed.json");
      await writeFile(malformedPath, JSON.stringify({
        schema: "shipwright-review-effects/v1",
        candidateId: value.candidateId,
        candidateDigest: value.candidateDigest,
        effects: [{
          effectId: "effect-malformed",
          kind: "not-a-real-effect",
          idempotencyKey: "bad",
          status: "intent",
        }],
        resumeCursor: 0,
      }));
      await expect(FileReviewEffectJournalStore.open(malformedPath, value)).rejects.toThrow("invalid schema");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("review artifact retention", () => {
  test("purges aged settled artifacts but preserves recovery state", async () => {
    const root = await mkdtemp(join(tmpdir(), "shipwright-retention-"));
    const now = "2026-07-22T00:00:00.000Z";
    try {
      const settled = candidate();
      const settledPath = reviewCandidatePath(root, settled.candidateId);
      const verificationStore = await FileReviewFindingVerificationStore.open(
        join(root, "review-verifications"),
      );
      const record = recordFor(settled);
      await verificationStore.put(record);
      await writeReviewCandidate(settledPath, {
        ...settled,
        verificationRecords: [createReviewEvidenceToken(record)],
      });

      const ambiguous = candidate({ candidateId: "candidate-ambiguous" });
      const ambiguousPath = reviewCandidatePath(root, ambiguous.candidateId);
      await writeReviewCandidate(ambiguousPath, ambiguous);
      const journal = await FileReviewEffectJournalStore.open(
        join(root, "review-effects", `${ambiguous.candidateId}.json`),
        ambiguous,
      );
      await journal.beginEffect({
        effectId: "effect-ambiguous",
        kind: "push",
        idempotencyKey: "push-ambiguous",
      });
      await journal.markAmbiguous({ effectId: "effect-ambiguous" });

      const orphan = candidate({ candidateId: "candidate-orphan" });
      const orphanJournalPath = join(
        root,
        "review-effects",
        `${orphan.candidateId}.json`,
      );
      const orphanJournal = await FileReviewEffectJournalStore.open(
        orphanJournalPath,
        orphan,
      );
      await orphanJournal.beginEffect({
        effectId: "effect-orphan",
        kind: "push",
        idempotencyKey: "push-orphan",
      });
      await orphanJournal.ackEffect({
        effectId: "effect-orphan",
        commitSha: HEAD_SHA,
      });
      await rm(join(root, "review-candidates", orphan.candidateId), {
        recursive: true,
        force: true,
      });
      const oldJournalTime = new Date("2026-07-20T00:00:00.000Z");
      await utimes(orphanJournalPath, oldJournalTime, oldJournalTime);


      const recent = candidate({ candidateId: "candidate-recent", createdAt: now });
      await writeReviewCandidate(reviewCandidatePath(root, recent.candidateId), recent);

      const result = await purgeReviewArtifacts(root, {
        maxAgeMs: 1_000,
        now,
      });
      expect(result.purgedCandidateIds).toEqual(["candidate-1"]);
      expect(result.purgedVerificationRecordIds).toEqual(["record-1"]);
      expect(result.purgedEffectJournalIds).toEqual(["candidate-orphan"]);
      // Filesystem directory order is not part of the retention contract.
      expect([...result.retainedCandidates].sort((left, right) =>
        left.candidateId.localeCompare(right.candidateId),
      )).toEqual([
        { candidateId: "candidate-ambiguous", reason: "unresolved-or-ambiguous-effect" },
        { candidateId: "candidate-recent", reason: "within-retention-window" },
      ]);
      await expect(readFile(settledPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readReviewCandidate(ambiguousPath)).resolves.toMatchObject({
        candidateId: "candidate-ambiguous",
      });
      await expect(
        readFile(join(root, "review-effects", `${ambiguous.candidateId}.json`), "utf8"),
      ).resolves.toContain("ambiguous");
      await expect(readFile(join(root, "review-verifications", "record-1.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(`${settledPath}.lock`, "utf8")).resolves.toBe("");
      await expect(readFile(orphanJournalPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(`${orphanJournalPath}.lock`, "utf8")).resolves.toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed on malformed candidates and dry-run does not delete", async () => {
    const root = await mkdtemp(join(tmpdir(), "shipwright-retention-safe-"));
    const old = candidate();
    const oldPath = reviewCandidatePath(root, old.candidateId);
    try {
      await writeReviewCandidate(oldPath, old);
      const malformedPath = reviewCandidatePath(root, "malformed");
      await mkdir(join(root, "review-candidates", "malformed"), { recursive: true });
      await writeFile(malformedPath, "{not-json");
      const dryRun = await purgeReviewArtifacts(root, {
        maxAgeMs: 1,
        now: "2026-07-22T00:00:00.000Z",
        dryRun: true,
      });
      expect(dryRun.purgedCandidateIds).toEqual([]);
      await expect(readFile(oldPath, "utf8")).resolves.toContain(old.candidateDigest);
      const result = await purgeReviewArtifacts(root, {
        maxAgeMs: 1,
        now: "2026-07-22T00:00:00.000Z",
      });
      expect(result.purgedCandidateIds).toEqual(["candidate-1"]);
      expect(result.retainedCandidates).toContainEqual({
        candidateId: "malformed",
        reason: "unreadable-candidate",
      });
      await expect(readFile(malformedPath, "utf8")).resolves.toBe("{not-json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
