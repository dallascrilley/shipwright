import { z } from "zod";
import type { ReviewFindingVerificationRecord } from "./repair-candidate.js";

const outcomeSchema = z.object({
  threadId: z.string().min(1),
  outcome: z.enum(["fixed", "deferred", "rejected", "already-addressed", "needs-human"]),
  summary: z.string().min(1).max(2_000),
  evidence: z.string().min(1).max(2_000),
  followUp: z.string().min(1).max(1_000).optional(),
  // Optional model proposal metadata. These values are selectors only; the host
  // resolver below binds closure to independently stored verification records.
  candidateId: z.string().min(1).max(256).optional(),
  candidateDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  findingId: z.string().min(1).max(256).optional(),
  findingDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  checksDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  repairIdentity: z.string().min(1).max(512).optional(),
}).strict();

const artifactSchema = z.object({
  threads: z.array(outcomeSchema),
}).strict();

export type ReviewOutcome = z.infer<typeof outcomeSchema>;

export interface ReviewOutcomeVerificationStore {
  lookup(input: {
    recordId: string;
    candidateDigest: string;
    findingId: string;
    findingDigest: string;
    checksDigest: string;
  }): Promise<ReviewFindingVerificationRecord | undefined>;
}

export interface ReviewOutcomeProofBinding {
  candidateDigest: string;
  checksDigest: string;
  findings: Readonly<Record<string, { recordId: string; findingId: string; findingContentDigest: string }>>;
  store: ReviewOutcomeVerificationStore;
}

export type VerifiedReviewDisposition =
  | "fixed"
  | "deferred"
  | "rejected"
  | "already-addressed"
  | "needs-human"
  | "pending";

export interface ResolvedReviewOutcome {
  threadId: string;
  proposed: ReviewOutcome;
  verified: {
    disposition: VerifiedReviewDisposition;
    status: "verified" | "pending" | "not-required";
    reason?: string;
    recordId?: string;
  };
}

export function parseReviewOutcomes(
  serialized: string,
  expectedThreadIds: string[],
  changedFiles?: string[],
): ReviewOutcome[] {
  const artifact = artifactSchema.parse(JSON.parse(serialized));
  const expected = new Set(expectedThreadIds);
  const seen = new Set<string>();
  for (const outcome of artifact.threads) {
    if (!expected.has(outcome.threadId)) throw new Error(`unknown review thread: ${outcome.threadId}`);
    if (seen.has(outcome.threadId)) throw new Error(`duplicate review thread: ${outcome.threadId}`);
    seen.add(outcome.threadId);
    if (outcome.outcome === "deferred" && !outcome.followUp) {
      throw new Error(`deferred review thread requires a follow-up: ${outcome.threadId}`);
    }
  }
  const missing = expectedThreadIds.filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`missing review threads: ${missing.join(", ")}`);
  if (artifact.threads.length !== expectedThreadIds.length) {
    throw new Error("review outcome count does not match the authorized thread set");
  }
  if (changedFiles && changedFiles.length === 0 && artifact.threads.some((item) => item.outcome === "fixed")) {
    throw new Error("fixed review outcomes require a repository change");
  }
  return artifact.threads;
}

/**
 * Resolve model proposals only against a host-owned, storage-backed proof.
 * Candidate/finding/check bindings come from the caller's authorized candidate,
 * never from proposal metadata or a model-supplied token. Missing or pending
 * proof is returned as a structured unresolved disposition for receipts.
 */
export async function resolveVerifiedReviewOutcomes(
  outcomes: readonly ReviewOutcome[],
  binding: ReviewOutcomeProofBinding,
): Promise<ResolvedReviewOutcome[]> {
  const resolved: ResolvedReviewOutcome[] = [];
  for (const proposed of outcomes) {
    if (proposed.outcome === "needs-human") {
      resolved.push({
        threadId: proposed.threadId,
        proposed: structuredClone(proposed),
        verified: { disposition: "needs-human", status: "not-required", reason: "model requested human review" },
      });
      continue;
    }
    const expected = binding.findings[proposed.threadId];
    if (!expected) {
      resolved.push({
        threadId: proposed.threadId,
        proposed: structuredClone(proposed),
        verified: { disposition: "pending", status: "pending", reason: "missing original finding binding" },
      });
      continue;
    }
    if (proposed.findingId !== undefined && proposed.findingId !== expected.findingId) {
      resolved.push({
        threadId: proposed.threadId,
        proposed: structuredClone(proposed),
        verified: { disposition: "pending", status: "pending", reason: "proposal finding identity does not match original finding" },
      });
      continue;
    }
    let record: ReviewFindingVerificationRecord | undefined;
    try {
      record = await binding.store.lookup({
        recordId: expected.recordId,
        candidateDigest: binding.candidateDigest,
        findingId: expected.findingId,
        findingDigest: expected.findingContentDigest,
        checksDigest: binding.checksDigest,
      });
    } catch (error) {
      resolved.push({
        threadId: proposed.threadId,
        proposed: structuredClone(proposed),
        verified: { disposition: "pending", status: "pending", reason: `host verification lookup failed: ${error instanceof Error ? error.message : "unknown error"}` },
      });
      continue;
    }
    if (!record) {
      resolved.push({
        threadId: proposed.threadId,
        proposed: structuredClone(proposed),
        verified: { disposition: "pending", status: "pending", reason: "missing or forged host verification binding" },
      });
      continue;
    }
    const invalidBinding = record.schema !== "shipwright-review-verification/v1"
      || record.recordId !== expected.recordId
      || record.candidateDigest !== binding.candidateDigest
      || record.findingId !== expected.findingId
      || record.findingDigest !== expected.findingContentDigest
      || record.checksDigest !== binding.checksDigest;
    if (invalidBinding) {
      resolved.push({
        threadId: proposed.threadId,
        proposed: structuredClone(proposed),
        verified: { disposition: "pending", status: "pending", reason: "missing or forged host verification binding" },
      });
      continue;
    }
    if (record.requiredChecks !== "passed") {
      resolved.push({
        threadId: proposed.threadId,
        proposed: structuredClone(proposed),
        verified: { disposition: "pending", status: "pending", reason: `required checks are ${record.requiredChecks}` , recordId: record.recordId },
      });
      continue;
    }
    if (record.independentVerdict !== "pass") {
      resolved.push({
        threadId: proposed.threadId,
        proposed: structuredClone(proposed),
        verified: { disposition: "pending", status: "pending", reason: `independent verdict is ${record.independentVerdict ?? "missing"}`, recordId: record.recordId },
      });
      continue;
    }
    if (record.observedOutcome === "deferred" && (
      !record.followUp
      || record.followUp.status !== "confirmed"
      || !record.followUp.idempotencyKey
      || !record.followUp.assignedTo
      || !record.followUp.repository
      || !record.followUp.remoteId
      || !record.followUp.remoteUrl
      || !/^https?:\/\//.test(record.followUp.remoteUrl)
      || (proposed.followUp !== undefined && record.followUp.remoteUrl !== proposed.followUp)
    )) {
      resolved.push({
        threadId: proposed.threadId,
        proposed: structuredClone(proposed),
        verified: { disposition: "pending", status: "pending", reason: "deferred outcome lacks confirmed owned follow-up readback", recordId: record.recordId },
      });
      continue;
    }
    const disposition = record.observedOutcome;
    if (disposition === "pending") {
      resolved.push({
        threadId: proposed.threadId,
        proposed: structuredClone(proposed),
        verified: { disposition, status: "pending", reason: "host verification is pending", recordId: record.recordId },
      });
      continue;
    }
    resolved.push({
      threadId: proposed.threadId,
      proposed: structuredClone(proposed),
      verified: { disposition, status: "verified", recordId: record.recordId },
    });
  }
  return resolved;
}
