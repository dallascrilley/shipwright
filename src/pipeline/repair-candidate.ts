import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReviewOutcome } from "./review-outcomes.js";
import { withNativeFileLock } from "./native-file-lock.js";
import { assertSecretSafeBytes, containsSecretLikeContent } from "./secret-safety.js";

export const REVIEW_CANDIDATE_SCHEMA = "shipwright-review-candidate/v1" as const;
export const REVIEW_CANDIDATE_PATCH_LIMIT = 1_048_576;
const REVIEW_METADATA_TEXT_LIMIT = 16_384;
const REVIEW_METADATA_ARRAY_LIMIT = 512;
const REVIEW_EFFECT_LIMIT = 256;
export const REVIEW_VERIFICATION_SCHEMA = "shipwright-review-verification/v1" as const;

export type ReviewCandidateDeliveryMode =
  | "patch"
  | "commit"
  | "follow-up-pr"
  | "evidence-only";
export type ReviewScopeMode = "this-review" | "all-current-findings";

export interface ReviewScope {
  mode: ReviewScopeMode;
  reviewId?: string;
  headSha?: string;
  findingIds: string[];
}

export interface ReviewBaseFreshness {
  baseBranch: string;
  authorizedBaseSha: string;
  observedBaseSha?: string;
  status: "fresh" | "stale" | "unavailable";
  integrationOwner: "original-pr-owner";
}

export type ReviewRepairLifecycle =
  | "proposed"
  | "delivered"
  | "integrated"
  | "verified";


/** Host-authored ownership proof; model output can never mint this object. */
export type ReviewOwnershipAuthorization =
  | {
      mode: "local-owner";
      ownerId: string;
      source: "operator" | "linear";
    }
  | {
      mode: "explicit-handoff";
      ownerId: string;
      fromOwnerId: string;
      handoffId: string;
      authorizedBy: string;
      source: "operator" | "linear";
    };

export type ReviewFindingVerification =
  | "fixed"
  | "deferred"
  | "rejected"
  | "already-addressed"
  | "needs-human"
  | "pending";

/** Host-authored grouping; duplicate findings may share one group. */
export interface ReviewFixGroup {
  groupId: string;
  findingIds: string[];
}

/** Immutable model proposal copied into a retained candidate; never closure authority. */
export interface ReviewFindingEvidence {
  findingId: string;
  /** Digest of the original review-thread content, excluding Shipwright receipt replies. */
  originalContentDigest?: string;
  proposedOutcome: ReviewOutcome["outcome"];
  summary: string;
  evidence: string;
  reproduction: string;
  affectedFiles: string[];
  /** Host-derived source actor and review/thread provenance. */
  source?: {
    reviewer: string;
    commentId: string;
    commentUrl: string;
    reviewIds: string[];
  };
  fixGroupId?: string;
  repairIdentity?: string;
}


/** Host-owned verification record. A model cannot mint or alter this record. */
export interface ReviewFindingVerificationRecord {
  schema: typeof REVIEW_VERIFICATION_SCHEMA;
  recordId: string;
  candidateDigest: string;
  findingId: string;
  findingDigest: string;
  checksDigest: string;
  observedOutcome: ReviewFindingVerification;
  observedEvidence: string;
  observedReproduction: string;
  observedAffectedFiles: string[];
  verificationBaseSha?: string;
  verificationHeadSha?: string;
  requiredChecks: "passed" | "failed" | "pending";
  riskLevel: "standard" | "high";
  independentVerdict: "pass" | "fail" | "disputed" | "pending";
  followUp?: {
    repository: string;
    remoteId: string;
    remoteUrl: string;
    kind: "issue" | "pr";
    idempotencyKey: string;
    assignedTo: string;
    status: "assigned" | "confirmed" | "disputed";
  };
  createdAt: string;
}

/** Opaque reference persisted in a candidate; read authority comes from the host store. */
export interface ReviewEvidenceToken {
  recordId: string;
  candidateDigest: string;
  findingId: string;
  findingDigest: string;
  checksDigest: string;
}

export interface ReviewVerificationObservation {
  expectedExitCode: number;
  resultDigest: string;
}

/**
 * Host-authored adjudication plan. The plan is imported and stored outside
 * the model workspace. It binds one exact original finding to a reproduction
 * command, expected baseline/candidate results, risk, and a fresh-context
 * independent reviewer verdict.
 */
export interface ReviewVerificationPlan {
  schema: "shipwright-review-verification-plan/v1";
  planId: string;
  candidateDigest: string;
  findingId: string;
  findingDigest: string;
  command: string;
  timeoutMs: number;
  /** Operator-classified, independently reviewed behavioral assertion. */
  reproduction?: {
    kind: "behavioral";
    assertion: string;
  };
  baseline: ReviewVerificationObservation;
  candidate: ReviewVerificationObservation;
  /** Host adjudication, never copied from the model proposal. */
  adjudicatedOutcome: Exclude<ReviewFindingVerification, "pending">;
  riskLevel: "standard" | "high";
  independentReview: {
    reviewerId: string;
    contextDigest: string;
    verdict: "pass" | "fail" | "disputed";
    freshContext: boolean;
  };
  followUp?: ReviewFindingVerificationRecord["followUp"];
  createdAt: string;
}

export interface ReviewVerificationPlanStore {
  lookup(input: {
    candidateDigest: string;
    findingId: string;
    findingDigest: string;
  }): Promise<ReviewVerificationPlan | undefined>;
  put(plan: ReviewVerificationPlan): Promise<void>;
}

export type ReviewEffectKind = "commit" | "push" | "reply" | "resolve" | "follow-up-pr";
export type ReviewEffectStatus = "intent" | "confirmed" | "ambiguous";

export interface ReviewEffectReceipt {
  effectId: string;
  kind: ReviewEffectKind;
  idempotencyKey: string;
  status: ReviewEffectStatus;
  remoteId?: string;
  remoteUrl?: string;
  commitSha?: string;
  detail?: string;
}

/** Explicit host authorization for one candidate's selected delivery scope. */
export interface ReviewAuthorizedDeliveryPlan {
  candidateDigest: string;
  deliveryMode: ReviewCandidateDeliveryMode;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  baseBranch: string;
  baseSha: string;
  headBranch: string;
  authorizedHeadSha: string;
  selectedFindingIds?: string[];
  ownership?: ReviewOwnershipAuthorization;
  followUpBaseBranch?: string;
  followUpBaseSha?: string;
}


export interface ReviewCandidateVerification {
  command: string;
  exitCode: number | null;
  passed: boolean;
  requiredChecks: "passed" | "failed" | "pending";
  stdoutTail?: string;
  stderrTail?: string;
}

/** Durable immutable repair inputs plus separately issued host proofs and effects. */
export interface ReviewCandidate {
  schema: typeof REVIEW_CANDIDATE_SCHEMA;
  candidateId: string;
  candidateDigest: string;
  authorizedBaseRef: string;
  authorizedBaseSha: string;
  authorizedHeadRef: string;
  authorizedHeadSha: string;
  resultingTreeSha: string;
  patchBase64: string;
  patchBytes: number;
  changedFiles: string[];
  findings: ReviewFindingEvidence[];
  fixGroups?: ReviewFixGroup[];
  provenance?: {
    taskId: string;
    runId: string;
    actor: string;
  };
  verification: ReviewCandidateVerification;
  /** Historical UI preference only; delivery authority lives in the journal plan. */
  deliveryMode: ReviewCandidateDeliveryMode;
  verificationRecords: ReviewEvidenceToken[];
  effects: ReviewEffectReceipt[];
  resumeCursor: number;
  createdAt: string;
}


export interface ReviewCandidateInput {
  candidateId: string;
  authorizedBaseRef: string;
  authorizedBaseSha: string;
  authorizedHeadRef: string;
  authorizedHeadSha: string;
  resultingTreeSha: string;
  patch: Uint8Array;
  changedFiles: readonly string[];
  findings: readonly ReviewFindingEvidence[];
  fixGroups?: readonly ReviewFixGroup[];
  provenance?: ReviewCandidate["provenance"];
  verification: ReviewCandidateVerification;
  deliveryMode: ReviewCandidateDeliveryMode;
  createdAt: string;
}

/** Journal storage is effect-agnostic; the publisher owns all remote effect calls. */
export interface ReviewEffectJournalStore {
  load(): Promise<ReviewEffectReceipt[]>;
  beginEffect(input: Pick<ReviewEffectReceipt, "effectId" | "kind" | "idempotencyKey">): Promise<ReviewEffectReceipt>;
  ackEffect(input: Pick<ReviewEffectReceipt, "effectId"> & Partial<Omit<ReviewEffectReceipt, "effectId">>): Promise<ReviewEffectReceipt>;
  ensureDeliveryPlan(plan: ReviewAuthorizedDeliveryPlan): Promise<ReviewAuthorizedDeliveryPlan>;
  markAmbiguous(input: Pick<ReviewEffectReceipt, "effectId"> & Partial<Pick<ReviewEffectReceipt, "detail">>): Promise<ReviewEffectReceipt>;
  getResumeCursor(): Promise<number>;
  setResumeCursor(cursor: number): Promise<void>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

type ReviewCandidateDigestInput = Omit<
  ReviewCandidate,
  "candidateDigest" | "verificationRecords" | "effects" | "resumeCursor" | "deliveryMode"
> & Partial<Pick<ReviewCandidate, "deliveryMode">>;

function immutableCandidateValue(candidate: ReviewCandidateDigestInput) {
  return {
    schema: candidate.schema,
    candidateId: candidate.candidateId,
    authorizedBaseRef: candidate.authorizedBaseRef,
    authorizedBaseSha: candidate.authorizedBaseSha,
    authorizedHeadRef: candidate.authorizedHeadRef,
    authorizedHeadSha: candidate.authorizedHeadSha,
    resultingTreeSha: candidate.resultingTreeSha,
    patchBase64: candidate.patchBase64,
    patchBytes: candidate.patchBytes,
    changedFiles: candidate.changedFiles,
    findings: candidate.findings,
    fixGroups: candidate.fixGroups,
    provenance: candidate.provenance,
    verification: candidate.verification,
    createdAt: candidate.createdAt,
  };
}

export function computeReviewCandidateDigest(
  candidate: ReviewCandidateDigestInput,
): string {
  return createHash("sha256")
    .update(stableJson(immutableCandidateValue(candidate)))
    .digest("hex");
}
/** Construct an opaque proof reference after an independent host record exists. */
export function createReviewEvidenceToken(record: ReviewFindingVerificationRecord): ReviewEvidenceToken {
  validateReviewVerificationRecord(record);
  return {
    recordId: record.recordId,
    candidateDigest: record.candidateDigest,
    findingId: record.findingId,
    findingDigest: record.findingDigest,
    checksDigest: record.checksDigest,
  };
}
export function computeReviewFindingDigest(finding: ReviewFindingEvidence): string {
  if (finding.originalContentDigest) return finding.originalContentDigest;
  return createHash("sha256").update(stableJson(finding)).digest("hex");
}

export function computeReviewChecksDigest(
  value: Pick<ReviewCandidateVerification, "command" | "exitCode" | "passed" | "requiredChecks"> & {
    verificationBaseSha?: string;
    verificationHeadSha?: string;
  },
): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export interface ReviewVerificationResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export function computeReviewVerificationResultDigest(
  result: ReviewVerificationResult,
): string {
  return createHash("sha256").update(stableJson(result)).digest("hex");
}

export function computeReviewVerificationContextDigest(input: {
  candidateDigest: string;
  findingId: string;
  findingDigest: string;
  command: string;
  timeoutMs: number;
  reproduction?: ReviewVerificationPlan["reproduction"];
  baseline: ReviewVerificationObservation;
  candidate: ReviewVerificationObservation;
  adjudicatedOutcome: ReviewVerificationPlan["adjudicatedOutcome"];
  riskLevel: ReviewVerificationPlan["riskLevel"];
  reviewerId: string;
}): string {
  return createHash("sha256")
    .update(stableJson({
      candidateDigest: input.candidateDigest,
      findingId: input.findingId,
      findingDigest: input.findingDigest,
      command: input.command,
      timeoutMs: input.timeoutMs,
      reproduction: input.reproduction,
      baseline: input.baseline,
      candidate: input.candidate,
      adjudicatedOutcome: input.adjudicatedOutcome,
      riskLevel: input.riskLevel,
      reviewerId: input.reviewerId,
    }))
    .digest("hex");
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertReviewVerificationPlanShape(plan: ReviewVerificationPlan): void {
  const validDigest = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  const validId = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
  const validReproduction =
    plan.reproduction === undefined ||
    (isRecord(plan.reproduction) &&
      plan.reproduction.kind === "behavioral" &&
      typeof plan.reproduction.assertion === "string" &&
      Boolean(plan.reproduction.assertion.trim()) &&
      plan.reproduction.assertion.length <= 4000);
  if (
    !isRecord(plan) ||
    plan.schema !== "shipwright-review-verification-plan/v1" ||
    !validId(plan.planId) ||
    !validDigest(plan.candidateDigest) ||
    typeof plan.findingId !== "string" ||
    !plan.findingId.trim() ||
    !validDigest(plan.findingDigest) ||
    typeof plan.command !== "string" ||
    !plan.command.trim() ||
    !validReproduction ||
    !Number.isInteger(plan.timeoutMs) ||
    plan.timeoutMs < 1 ||
    plan.timeoutMs > 10 * 60 * 1000 ||
    !isRecord(plan.baseline) ||
    !isRecord(plan.candidate) ||
    !isRecord(plan.independentReview)
  ) {
    throw new Error("review verification plan is invalid");
  }
  // Classification is host authority, not inferred from a model's command.
  // Static-only commands and no-op shell chains cannot substantiate a behavioral declaration.
  const commands = plan.command.split(/\s*(?:&&|;|\|\|)\s*/).map((command) => command.trim()).filter(Boolean);
  const staticOnlyCommand = /^(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:lint|typecheck)(?:\s|$)|(?:tsc|eslint|prettier|biome|stylelint|markdownlint)(?:\s|$)|(?:pwd|false|true|:|echo|printf)(?:\s|$))/i;
  if (commands.length === 0 || commands.every((command) => staticOnlyCommand.test(command))) {
    throw new Error("static-only checks cannot verify a behavioral finding");
  }
  if (containsSecretLikeContent(stableJson(plan))) {
    throw new Error("review verification plan contains secret-shaped content");
  }
  if (
    !Number.isInteger(plan.baseline.expectedExitCode) ||
    !validDigest(plan.baseline.resultDigest) ||
    !Number.isInteger(plan.candidate.expectedExitCode) ||
    !validDigest(plan.candidate.resultDigest) ||
    ![
      "fixed",
      "deferred",
      "rejected",
      "already-addressed",
      "needs-human",
    ].includes(plan.adjudicatedOutcome) ||
    !["standard", "high"].includes(plan.riskLevel) ||
    typeof plan.independentReview.reviewerId !== "string" ||
    !plan.independentReview.reviewerId.trim() ||
    !validDigest(plan.independentReview.contextDigest) ||
    !["pass", "fail", "disputed"].includes(plan.independentReview.verdict) ||
    typeof plan.independentReview.freshContext !== "boolean" ||
    typeof plan.createdAt !== "string" ||
    Number.isNaN(Date.parse(plan.createdAt))
  ) {
    throw new Error("review verification plan is invalid");
  }
  const validFollowUp = plan.followUp === undefined || (
    isRecord(plan.followUp) &&
    typeof plan.followUp.repository === "string" &&
    /^[^/\s]+\/[^/\s]+$/.test(plan.followUp.repository) &&
    typeof plan.followUp.remoteId === "string" &&
    Boolean(plan.followUp.remoteId.trim()) &&
    isHttpsUrl(plan.followUp.remoteUrl) &&
    (plan.followUp.kind === "issue" || plan.followUp.kind === "pr") &&
    typeof plan.followUp.idempotencyKey === "string" &&
    Boolean(plan.followUp.idempotencyKey.trim()) &&
    typeof plan.followUp.assignedTo === "string" &&
    Boolean(plan.followUp.assignedTo.trim()) &&
    (plan.followUp.status === "assigned" ||
      plan.followUp.status === "confirmed" ||
      plan.followUp.status === "disputed")
  );
  if (
    !validFollowUp ||
    (plan.adjudicatedOutcome === "deferred" &&
      (!plan.followUp || plan.followUp.status !== "confirmed")) ||
    (plan.adjudicatedOutcome !== "deferred" && plan.followUp !== undefined)
  ) {
    throw new Error("review verification plan is invalid");
  }
  if (
    plan.adjudicatedOutcome === "fixed" &&
    (plan.baseline.expectedExitCode === 0 || plan.candidate.expectedExitCode !== 0)
  ) {
    throw new Error("fixed review verification plans require a failing baseline and passing candidate");
  }
  if (
    (plan.adjudicatedOutcome === "rejected" ||
      plan.adjudicatedOutcome === "already-addressed" ||
      plan.adjudicatedOutcome === "needs-human") &&
    (plan.baseline.expectedExitCode !== 0 || plan.candidate.expectedExitCode !== 0)
  ) {
    throw new Error("no-code review verification plans require a non-failing baseline and candidate");
  }
  const expectedContextDigest = computeReviewVerificationContextDigest({
    candidateDigest: plan.candidateDigest,
    findingId: plan.findingId,
    findingDigest: plan.findingDigest,
    command: plan.command,
    timeoutMs: plan.timeoutMs,
    reproduction: plan.reproduction,
    baseline: {
      expectedExitCode: plan.baseline.expectedExitCode,
      resultDigest: plan.baseline.resultDigest,
    },
    candidate: {
      expectedExitCode: plan.candidate.expectedExitCode,
      resultDigest: plan.candidate.resultDigest,
    },
    adjudicatedOutcome: plan.adjudicatedOutcome,
    riskLevel: plan.riskLevel,
    reviewerId: plan.independentReview.reviewerId,
  });
  if (plan.independentReview.contextDigest !== expectedContextDigest) {
    throw new Error("review verification plan reviewer context is not bound to its inputs");
  }
}

export function assertReviewVerificationPlan(plan: ReviewVerificationPlan): void {
  assertReviewVerificationPlanShape(plan);
}

function reviewVerificationPlanPath(
  root: string,
  candidateDigest: string,
  findingDigest: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(candidateDigest) || !/^[0-9a-f]{64}$/.test(findingDigest)) {
    throw new Error("review verification plan digest is invalid");
  }
  return join(
    root,
    "review-verification-plans",
    candidateDigest,
    `${findingDigest}.json`,
  );
}

export class FileReviewVerificationPlanStore
  implements ReviewVerificationPlanStore
{
  constructor(private readonly root: string) {}

  async lookup(input: {
    candidateDigest: string;
    findingId: string;
    findingDigest: string;
  }): Promise<ReviewVerificationPlan | undefined> {
    const path = reviewVerificationPlanPath(
      this.root,
      input.candidateDigest,
      input.findingDigest,
    );
    try {
      const plan = JSON.parse(await readFile(path, "utf8")) as ReviewVerificationPlan;
      assertReviewVerificationPlanShape(plan);
      if (
        plan.candidateDigest !== input.candidateDigest ||
        plan.findingId !== input.findingId ||
        plan.findingDigest !== input.findingDigest
      ) {
        return undefined;
      }
      return plan;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async put(plan: ReviewVerificationPlan): Promise<void> {
    assertReviewVerificationPlanShape(plan);
    const path = reviewVerificationPlanPath(
      this.root,
      plan.candidateDigest,
      plan.findingDigest,
    );
    await withNativeFileLock(reviewArtifactRootLock(verificationPlanArtifactRoot(this.root)), async (assertRootHeld) => {
      await withNativeFileLock(`${path}.lock`, async (assertHeld) => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporaryPath, `${JSON.stringify(plan, null, 2)}\n`, {
            mode: 0o600,
          });
          await assertRootHeld();
          await assertHeld();
          try {
            await link(temporaryPath, path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const existing = JSON.parse(await readFile(path, "utf8")) as ReviewVerificationPlan;
            assertReviewVerificationPlanShape(existing);
            if (stableJson(existing) !== stableJson(plan)) {
              throw new Error("review verification plan is immutable");
            }
          }
        } finally {
          await rm(temporaryPath, { force: true });
        }
      });
    });
  }
}

/** Validate only the persisted host record binding; this function never authorizes closure. */
export function assertReviewEvidenceRecord(
  record: ReviewFindingVerificationRecord,
  input: {
    candidateDigest: string;
    finding: ReviewFindingEvidence;
    checks: Pick<
      ReviewCandidateVerification,
      "command" | "exitCode" | "passed" | "requiredChecks"
    >;
  },
): void {
  validateReviewVerificationRecord(record);
  if (
    record.candidateDigest !== input.candidateDigest ||
    record.findingId !== input.finding.findingId ||
    record.findingDigest !== computeReviewFindingDigest(input.finding) ||
    record.checksDigest !== computeReviewChecksDigest(input.checks)
  ) {
    throw new Error(
      `review verification record does not match finding ${input.finding.findingId}`,
    );
  }
  if (record.requiredChecks !== "passed") {
    throw new Error(
      `finding ${input.finding.findingId} lacks passing required checks`,
    );
  }
  if (
    record.riskLevel === "high" &&
    record.observedOutcome !== "deferred" &&
    record.independentVerdict !== "pass"
  ) {
    throw new Error(
      `high-risk finding ${input.finding.findingId} lacks an independent pass verdict`,
    );
  }
  if (
    record.observedOutcome === "deferred" &&
    (!record.followUp || record.followUp.status !== "confirmed")
  ) {
    throw new Error(
      `deferred finding ${input.finding.findingId} lacks a confirmed host follow-up`,
    );
  }
}

function assertSafeCandidateId(candidateId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(candidateId)) {
    throw new Error("review candidate id must be a bounded identifier-safe value");
  }
}

export function createReviewCandidate(input: ReviewCandidateInput): ReviewCandidate {
  assertSafeCandidateId(input.candidateId);
  if (input.patch.byteLength > REVIEW_CANDIDATE_PATCH_LIMIT) {
    throw new Error(`review candidate patch limit is ${REVIEW_CANDIDATE_PATCH_LIMIT} bytes`);
  }
  assertSecretSafeBytes(input.patch);
  const immutable = {
    schema: REVIEW_CANDIDATE_SCHEMA,
    candidateId: input.candidateId,
    authorizedBaseRef: input.authorizedBaseRef,
    authorizedBaseSha: input.authorizedBaseSha,
    authorizedHeadRef: input.authorizedHeadRef,
    authorizedHeadSha: input.authorizedHeadSha,
    resultingTreeSha: input.resultingTreeSha,
    patchBase64: Buffer.from(input.patch).toString("base64"),
    patchBytes: input.patch.byteLength,
    changedFiles: [...input.changedFiles].sort(),
    findings: input.findings.map((finding) => structuredClone(finding)),
    ...(input.fixGroups ? { fixGroups: input.fixGroups.map((group) => structuredClone(group)) } : {}),
    ...(input.provenance ? { provenance: structuredClone(input.provenance) } : {}),
    verification: structuredClone(input.verification),
    deliveryMode: input.deliveryMode,
    createdAt: input.createdAt,
  } satisfies Omit<ReviewCandidate, "candidateDigest" | "verificationRecords" | "effects" | "resumeCursor">;
  const candidate = {
    ...immutable,
    candidateDigest: computeReviewCandidateDigest(immutable),
    verificationRecords: [],
    effects: [],
    resumeCursor: 0,
  };
  assertReviewCandidate(candidate);
  return candidate;
}

function assertBoundedText(label: string, value: unknown, max = REVIEW_METADATA_TEXT_LIMIT): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
}

function assertBoundedArray(label: string, value: unknown, max = REVIEW_METADATA_ARRAY_LIMIT): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} exceeds its bounded limit`);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function assertReviewEffectReceipt(effect: ReviewEffectReceipt): void {
  assertBoundedText("review effect id", effect.effectId, 160);
  if (!(effect.kind === "commit" || effect.kind === "push" || effect.kind === "reply" || effect.kind === "resolve" || effect.kind === "follow-up-pr")) {
    throw new Error(`invalid review effect kind ${effect.kind}`);
  }
  assertBoundedText("review effect idempotency key", effect.idempotencyKey, 256);
  if (!(effect.status === "intent" || effect.status === "confirmed" || effect.status === "ambiguous")) {
    throw new Error(`invalid review effect status ${effect.status}`);
  }
  if (effect.detail !== undefined && (typeof effect.detail !== "string" || effect.detail.length > REVIEW_METADATA_TEXT_LIMIT)) {
    throw new Error(`review effect ${effect.effectId} detail is too large`);
  }
  const hasCommit = effect.commitSha !== undefined;
  const hasRemoteId = effect.remoteId !== undefined;
  const hasRemoteUrl = effect.remoteUrl !== undefined;
  if ((effect.kind === "commit" || effect.kind === "push") && (hasRemoteId || hasRemoteUrl)) throw new Error(`review effect ${effect.effectId} has an invalid commit result`);
  if (effect.kind === "reply" && (hasCommit || hasRemoteId)) throw new Error(`review effect ${effect.effectId} has an invalid reply result`);
  if (effect.kind === "resolve" && (hasCommit || hasRemoteUrl)) throw new Error(`review effect ${effect.effectId} has an invalid resolve result`);
  if (effect.kind === "follow-up-pr" && hasCommit) throw new Error(`review effect ${effect.effectId} has an invalid follow-up result`);
  if (hasCommit && !isSha(effect.commitSha)) throw new Error(`review effect ${effect.effectId} commit SHA is invalid`);
  if (hasRemoteId) assertBoundedText("review effect remote id", effect.remoteId, 160);
  if (hasRemoteUrl && !isHttpsUrl(effect.remoteUrl)) throw new Error(`review effect ${effect.effectId} remote URL is invalid`);
  if (effect.status === "intent" && (hasCommit || hasRemoteId || hasRemoteUrl)) {
    throw new Error(`review effect ${effect.effectId} intent contains a remote result`);
  }
  if (effect.status === "confirmed") {
    const complete = effect.kind === "commit" || effect.kind === "push"
      ? hasCommit
      : effect.kind === "reply"
        ? hasRemoteUrl
        : effect.kind === "resolve"
          ? hasRemoteId
          : hasRemoteId && hasRemoteUrl;
    if (!complete) throw new Error(`review effect ${effect.effectId} confirmation is incomplete`);
  }
}

function assertReviewFindingEvidence(finding: ReviewFindingEvidence): void {
  assertBoundedText("review finding id", finding.findingId, 160);
  assertBoundedText("review finding summary", finding.summary);
  assertBoundedText("review finding evidence", finding.evidence);
  if (typeof finding.reproduction !== "string" || finding.reproduction.length > REVIEW_METADATA_TEXT_LIMIT) throw new Error("review finding reproduction is invalid");
  assertBoundedArray("review finding affected files", finding.affectedFiles);
  for (const file of finding.affectedFiles) assertBoundedText("review finding affected file", file, 512);
  if (finding.originalContentDigest !== undefined && !/^[0-9a-f]{64}$/.test(finding.originalContentDigest)) throw new Error("review finding original content digest is invalid");
  if (finding.source) {
    assertBoundedText("review finding reviewer", finding.source.reviewer, 160);
    assertBoundedText("review finding comment id", finding.source.commentId, 160);
    assertBoundedText("review finding comment URL", finding.source.commentUrl, 2048);
    assertBoundedArray("review finding review ids", finding.source.reviewIds, 64);
    for (const reviewId of finding.source.reviewIds) assertBoundedText("review finding review id", reviewId, 160);
  }
  if (finding.fixGroupId !== undefined) assertBoundedText("review finding fix group id", finding.fixGroupId, 160);
  if (finding.repairIdentity !== undefined) assertBoundedText("review finding repair identity", finding.repairIdentity);
}


function assertReviewVerificationRecordBounds(record: ReviewFindingVerificationRecord): void {
  assertBoundedText("verification record id", record.recordId, 160);
  assertBoundedText("verification finding id", record.findingId, 160);
  assertBoundedText("verification evidence", record.observedEvidence);
  assertBoundedText("verification reproduction", record.observedReproduction);
  assertBoundedArray("verification affected files", record.observedAffectedFiles);
  for (const file of record.observedAffectedFiles) assertBoundedText("verification affected file", file, 512);
  if (record.verificationBaseSha !== undefined && !isSha(record.verificationBaseSha)) throw new Error("verification base SHA is invalid");
  if (record.verificationHeadSha !== undefined && !isSha(record.verificationHeadSha)) throw new Error("verification head SHA is invalid");
  if (record.followUp) {
    assertBoundedText("follow-up repository", record.followUp.repository, 256);
    assertBoundedText("follow-up remote id", record.followUp.remoteId, 160);
    assertBoundedText("follow-up assignee", record.followUp.assignedTo, 160);
    assertBoundedText("follow-up idempotency key", record.followUp.idempotencyKey, 256);
  }
}

function assertReviewFixGroups(
  groups: readonly ReviewFixGroup[] | undefined,
  findings: readonly ReviewFindingEvidence[],
): void {
  if (groups === undefined) return;
  assertBoundedArray("review candidate fix groups", groups, findings.length || 1);
  const findingIds = new Set(findings.map((finding) => finding.findingId));
  const assigned = new Set<string>();
  for (const group of groups) {
    assertBoundedText("review fix group id", group.groupId, 160);
    assertBoundedArray("review fix group findings", group.findingIds, findings.length || 1);
    if (group.findingIds.length === 0) throw new Error("review fix group cannot be empty");
    for (const findingId of group.findingIds) {
      assertBoundedText("review fix group finding id", findingId, 160);
      if (!findingIds.has(findingId)) throw new Error(`review fix group references unknown finding ${findingId}`);
      if (assigned.has(findingId)) throw new Error(`review finding belongs to multiple fix groups: ${findingId}`);
      assigned.add(findingId);
    }
  }
  if (assigned.size !== findingIds.size) throw new Error("review fix groups must cover every finding");
}

function assertReviewCandidateProvenance(provenance: ReviewCandidate["provenance"]): void {
  if (!provenance) return;
  assertBoundedText("review candidate task id", provenance.taskId, 160);
  assertBoundedText("review candidate run id", provenance.runId, 160);
  assertBoundedText("review candidate actor", provenance.actor, 160);
}


export function assertReviewCandidate(candidate: ReviewCandidate): void {
  if (!/^[0-9a-f]{64}$/.test(candidate.candidateDigest)) {
    throw new Error("review candidate digest is invalid");
  }
  if (candidate.schema !== REVIEW_CANDIDATE_SCHEMA) throw new Error("unsupported review candidate schema");
  assertSafeCandidateId(candidate.candidateId);
  if (candidate.patchBase64 !== Buffer.from(candidate.patchBase64, "base64").toString("base64")) {
    throw new Error("review candidate patch is not canonical base64");
  }
  const patch = Buffer.from(candidate.patchBase64, "base64");
  if (patch.byteLength !== candidate.patchBytes || patch.byteLength > REVIEW_CANDIDATE_PATCH_LIMIT) {
    throw new Error("review candidate patch bytes do not match metadata");
  }
  assertSecretSafeBytes(patch);
  assertBoundedText("review candidate base SHA", candidate.authorizedBaseSha, 128);
  assertBoundedText("review candidate head SHA", candidate.authorizedHeadSha, 128);
  if (typeof candidate.resultingTreeSha !== "string" || candidate.resultingTreeSha.length > 128) throw new Error("review candidate resulting tree SHA is invalid");
  assertBoundedText("review candidate head ref", candidate.authorizedHeadRef, 512);
  assertBoundedArray("review candidate changed files", candidate.changedFiles);
  for (const file of candidate.changedFiles) assertBoundedText("review candidate changed file", file, 512);
  assertBoundedArray("review candidate findings", candidate.findings);
  for (const finding of candidate.findings) assertReviewFindingEvidence(finding);
  assertReviewFixGroups(candidate.fixGroups, candidate.findings);
  assertReviewCandidateProvenance(candidate.provenance);

  assertBoundedText("review candidate verification command", candidate.verification.command);
  if (candidate.verification.stdoutTail !== undefined && candidate.verification.stdoutTail.length > REVIEW_METADATA_TEXT_LIMIT) throw new Error("review candidate stdout tail is too large");
  if (candidate.verification.stderrTail !== undefined && candidate.verification.stderrTail.length > REVIEW_METADATA_TEXT_LIMIT) throw new Error("review candidate stderr tail is too large");
  if (!(candidate.deliveryMode === "patch" || candidate.deliveryMode === "commit" || candidate.deliveryMode === "follow-up-pr" || candidate.deliveryMode === "evidence-only")) throw new Error("review candidate delivery preference is invalid");
  assertBoundedArray("review candidate verification records", candidate.verificationRecords);
  for (const token of candidate.verificationRecords) {
    assertBoundedText("review evidence token record id", token.recordId, 160);
    if (!/^[0-9a-f]{64}$/.test(token.candidateDigest) || !/^[0-9a-f]{64}$/.test(token.findingDigest) || !/^[0-9a-f]{64}$/.test(token.checksDigest)) throw new Error("review evidence token digest is invalid");
    assertBoundedText("review evidence token finding id", token.findingId, 160);
  }
  assertBoundedArray("review candidate effects", candidate.effects, REVIEW_EFFECT_LIMIT);
  for (const effect of candidate.effects) assertReviewEffectReceipt(effect);
  if (!Number.isInteger(candidate.resumeCursor) || candidate.resumeCursor < 0) throw new Error("review candidate resume cursor is invalid");
  if (typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt))) throw new Error("review candidate creation time is invalid");
  if (containsSecretLikeContent(stableJson(candidate))) {
    throw new Error("review candidate contains secret-shaped content");
  }
  if (computeReviewCandidateDigest(immutableCandidateValue(candidate)) !== candidate.candidateDigest) {
    throw new Error("review candidate digest does not match immutable content");
  }
}

export function reviewCandidatePatch(candidate: ReviewCandidate): Uint8Array {
  assertReviewCandidate(candidate);
  return new Uint8Array(Buffer.from(candidate.patchBase64, "base64"));
}

export function reviewCandidatePath(root: string, candidateId: string): string {
  assertSafeCandidateId(candidateId);
  return join(root, "review-candidates", candidateId, "candidate.json");
}

const REVIEW_ARTIFACT_ROOT_LOCK = ".review-artifacts.lock";

function reviewArtifactRootLock(root: string): string {
  return join(root, REVIEW_ARTIFACT_ROOT_LOCK);
}

function candidateArtifactRoot(path: string): string {
  return dirname(dirname(dirname(path)));
}

function effectArtifactRoot(path: string): string {
  return dirname(dirname(path));
}

function verificationArtifactRoot(path: string): string {
  return dirname(dirname(path));
}

function verificationPlanArtifactRoot(root: string): string {
  return root;
}

export async function writeReviewCandidate(path: string, candidate: ReviewCandidate): Promise<void> {
  assertReviewCandidate(candidate);
  await withNativeFileLock(reviewArtifactRootLock(candidateArtifactRoot(path)), async (assertRootHeld) => {
    await withNativeFileLock(`${path}.lock`, async (assertHeld) => {
      let existing: ReviewCandidate | undefined;
      try {
        existing = await readReviewCandidate(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const next = existing ? mergeCandidateState(existing, candidate) : candidate;
      await assertRootHeld();
      await assertHeld();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        await assertRootHeld();
        await assertHeld();
        await rename(temporaryPath, path);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    });
  });
}

export async function readReviewCandidate(path: string): Promise<ReviewCandidate> {
  const candidate = JSON.parse(await readFile(path, "utf8")) as ReviewCandidate;
  assertReviewCandidate(candidate);
  return candidate;
}


function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
function validateReviewVerificationRecord(record: ReviewFindingVerificationRecord): void {
  assertReviewVerificationRecordBounds(record);
  const followUp = record.followUp;
  if (
    record.schema !== REVIEW_VERIFICATION_SCHEMA ||
    typeof record.recordId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(record.recordId) ||
    !/^[0-9a-f]{64}$/.test(record.candidateDigest) ||
    !/^[0-9a-f]{64}$/.test(record.findingDigest) ||
    !/^[0-9a-f]{64}$/.test(record.checksDigest) ||
    typeof record.findingId !== "string" ||
    typeof record.observedEvidence !== "string" ||
    !record.observedEvidence.trim() ||
    typeof record.observedReproduction !== "string" ||
    !record.observedReproduction.trim() ||
    !["fixed", "deferred", "rejected", "already-addressed", "needs-human", "pending"].includes(record.observedOutcome) ||
    !["passed", "failed", "pending"].includes(record.requiredChecks) ||
    !["standard", "high"].includes(record.riskLevel) ||
    !["pass", "fail", "disputed", "pending"].includes(record.independentVerdict) ||
    !Array.isArray(record.observedAffectedFiles) ||
    record.observedAffectedFiles.some((path) => typeof path !== "string" || path.length === 0) ||
    (followUp !== undefined &&
      (typeof followUp !== "object" ||
        followUp === null ||
        typeof followUp.repository !== "string" ||
        !/^[^/\s]+\/[^/\s]+$/.test(followUp.repository) ||
        typeof followUp.remoteId !== "string" ||
        !followUp.remoteId.trim() ||
        !isHttpsUrl(followUp.remoteUrl) ||
        !["issue", "pr"].includes(followUp.kind) ||
        typeof followUp.idempotencyKey !== "string" ||
        !followUp.idempotencyKey.trim() ||
        typeof followUp.assignedTo !== "string" ||
        !followUp.assignedTo.trim() ||
        !["assigned", "confirmed", "disputed"].includes(followUp.status))) ||
    typeof record.createdAt !== "string" ||
    Number.isNaN(Date.parse(record.createdAt))
  ) {
    throw new Error(`invalid review verification record ${record.recordId}`);
  }
  if (record.observedOutcome === "deferred" && !followUp) {
    throw new Error(`deferred finding ${record.findingId} requires a host follow-up`);
  }
  if (record.observedOutcome !== "deferred" && followUp) {
    throw new Error(`host follow-up is only valid for deferred finding ${record.findingId}`);
  }

}

/** Host-only verification store; records are addressed by opaque IDs and never model supplied. */
export class FileReviewFindingVerificationStore {
  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<FileReviewFindingVerificationStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new FileReviewFindingVerificationStore(root);
  }
  async put(record: ReviewFindingVerificationRecord): Promise<void> {
    validateReviewVerificationRecord(record);
    if (containsSecretLikeContent(stableJson(record))) {
      throw new Error("review verification record contains secret-shaped content");
    }
    const path = join(this.root, `${record.recordId}.json`);
    await withNativeFileLock(reviewArtifactRootLock(verificationArtifactRoot(path)), async (assertRootHeld) => {
      await withNativeFileLock(`${path}.lock`, async (assertHeld) => {
        const temporaryPath = join(this.root, `.${record.recordId}.${randomUUID()}.tmp`);
        await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        try {
          await assertRootHeld();
          await assertHeld();
          try {
            await link(temporaryPath, path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const existing = JSON.parse(await readFile(path, "utf8")) as ReviewFindingVerificationRecord;
            validateReviewVerificationRecord(existing);
            if (stableJson(existing) !== stableJson(record)) {
              throw new Error(`review verification record ${record.recordId} is immutable`);
            }
          }
        } finally {
          await rm(temporaryPath, { force: true });
        }
      });
    });
  }

  async lookup(input: {
    recordId: string;
    candidateDigest: string;
    findingId: string;
    findingDigest: string;
    checksDigest: string;
  }): Promise<ReviewFindingVerificationRecord | undefined> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.recordId)) {
      throw new Error("invalid review verification record id");
    }
    let record: ReviewFindingVerificationRecord;
    try {
      record = JSON.parse(
        await readFile(join(this.root, `${input.recordId}.json`), "utf8"),
      ) as ReviewFindingVerificationRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    validateReviewVerificationRecord(record);
    if (
      record.recordId !== input.recordId ||
      record.candidateDigest !== input.candidateDigest ||
      record.findingId !== input.findingId ||
      record.findingDigest !== input.findingDigest ||
      record.checksDigest !== input.checksDigest
    ) {
      return undefined;
    }
    return structuredClone(record);
  }
}


function mergeCandidateState(existing: ReviewCandidate, incoming: ReviewCandidate): ReviewCandidate {
  if (existing.candidateDigest !== incoming.candidateDigest) throw new Error(`review candidate ${incoming.candidateId} is immutable`);
  const effects = [...existing.effects];
  for (const incomingEffect of incoming.effects) {
    const index = effects.findIndex((effect) => effect.effectId === incomingEffect.effectId);
    if (index < 0) {
      effects.push(incomingEffect);
      continue;
    }
    const current = effects[index]!;
    if (current.kind !== incomingEffect.kind || current.idempotencyKey !== incomingEffect.idempotencyKey) throw new Error(`review effect ${incomingEffect.effectId} does not match its existing intent`);
    const rank = (status: ReviewEffectStatus) => status === "confirmed" ? 2 : status === "ambiguous" ? 1 : 0;
    const winner = rank(incomingEffect.status) > rank(current.status) ? incomingEffect : current;
    if (rank(incomingEffect.status) === rank(current.status) && current.status !== "intent" && stableJson(current) !== stableJson(incomingEffect)) throw new Error(`review effect ${incomingEffect.effectId} has conflicting results`);
    effects[index] = winner;
  }
  const tokens = [...existing.verificationRecords];
  for (const incomingToken of incoming.verificationRecords) {
    const index = tokens.findIndex((token) =>
      token.findingId === incomingToken.findingId && token.checksDigest === incomingToken.checksDigest,
    );
    if (index < 0) tokens.push(incomingToken);
    else if (stableJson(tokens[index]) !== stableJson(incomingToken)) throw new Error(`review evidence token ${incomingToken.findingId} has conflicting results`);
  }
  const merged: ReviewCandidate = {
    ...incoming,
    deliveryMode: existing.deliveryMode,
    effects,
    verificationRecords: tokens,
    resumeCursor: Math.max(existing.resumeCursor, incoming.resumeCursor),
  };
  assertReviewCandidate(merged);
  return merged;
}

interface StoredJournal {
  schema: "shipwright-review-effects/v1";
  candidateId: string;
  candidateDigest: string;
  deliveryPlan?: ReviewAuthorizedDeliveryPlan;
  effects: ReviewEffectReceipt[];
  resumeCursor: number;
}

function assertReviewDeliveryPlan(plan: ReviewAuthorizedDeliveryPlan): void {
  if (!isRecord(plan) || !/^[0-9a-f]{64}$/.test(plan.candidateDigest)) throw new Error("review delivery plan candidate digest is invalid");
  if (!(plan.deliveryMode === "patch" || plan.deliveryMode === "commit" || plan.deliveryMode === "follow-up-pr" || plan.deliveryMode === "evidence-only")) throw new Error("review delivery plan mode is invalid");
  assertBoundedText("review delivery plan owner", plan.owner, 120);
  assertBoundedText("review delivery plan repo", plan.repo, 120);
  if (!Number.isInteger(plan.pullRequestNumber) || plan.pullRequestNumber < 1) throw new Error("review delivery plan pull request number is invalid");
  assertBoundedText("review delivery plan base branch", plan.baseBranch, 512);
  assertBoundedText("review delivery plan base SHA", plan.baseSha, 128);
  assertBoundedText("review delivery plan head branch", plan.headBranch, 512);
  assertBoundedText("review delivery plan authorized head SHA", plan.authorizedHeadSha, 128);
  if (plan.selectedFindingIds !== undefined) {
    assertBoundedArray("review delivery plan selected findings", plan.selectedFindingIds, REVIEW_METADATA_ARRAY_LIMIT);
    const uniqueFindingIds = new Set<string>();
    for (const findingId of plan.selectedFindingIds) {
      assertBoundedText("review delivery plan selected finding", findingId, 160);
      if (uniqueFindingIds.has(findingId)) throw new Error("review delivery plan selected findings must be unique");
      uniqueFindingIds.add(findingId);
    }
    if (uniqueFindingIds.size === 0) throw new Error("review delivery plan selected findings cannot be empty");
  }
  if (plan.ownership) {
    if (plan.ownership.mode === "local-owner") {
      assertBoundedText("review ownership owner", plan.ownership.ownerId, 160);
    } else if (plan.ownership.mode === "explicit-handoff") {
      assertBoundedText("review handoff owner", plan.ownership.ownerId, 160);
      assertBoundedText("review handoff source owner", plan.ownership.fromOwnerId, 160);
      assertBoundedText("review handoff id", plan.ownership.handoffId, 256);
      assertBoundedText("review handoff authorized by", plan.ownership.authorizedBy, 160);
    } else {
      throw new Error("review ownership authorization mode is invalid");
    }
    if (plan.ownership.source !== "operator" && plan.ownership.source !== "linear") {
      throw new Error("review ownership authorization source is invalid");
    }
  }
  if (plan.deliveryMode === "commit" && plan.ownership?.mode !== "explicit-handoff") {
    throw new Error("direct review commit requires an explicit ownership handoff");
  }
  if (plan.deliveryMode === "follow-up-pr") {
    assertBoundedText("review delivery plan follow-up base branch", plan.followUpBaseBranch, 512);
    assertBoundedText("review delivery plan follow-up base SHA", plan.followUpBaseSha, 128);
  } else if (plan.followUpBaseSha !== undefined || plan.followUpBaseBranch !== undefined) {
    throw new Error("non-follow-up delivery plan cannot select a follow-up base");
  }
  if (containsSecretLikeContent(stableJson(plan))) throw new Error("review delivery plan contains secret-shaped content");
}

function isStoredJournal(value: unknown): value is StoredJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<StoredJournal>;
  try {
    if (
      state.schema !== "shipwright-review-effects/v1" ||
      typeof state.candidateId !== "string" ||
      typeof state.candidateDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(state.candidateDigest) ||
      !Array.isArray(state.effects) ||
      state.effects.length > REVIEW_EFFECT_LIMIT ||
      typeof state.resumeCursor !== "number" ||
      !Number.isInteger(state.resumeCursor) ||
      state.resumeCursor < 0
    ) return false;
    for (const effect of state.effects) assertReviewEffectReceipt(effect as ReviewEffectReceipt);
    if (state.deliveryPlan !== undefined) assertReviewDeliveryPlan(state.deliveryPlan);
    return true;
  } catch {
    return false;
  }
}

function parseStoredJournal(
  raw: string,
  expected?: Pick<StoredJournal, "candidateId" | "candidateDigest">,
): StoredJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("review effect journal is not valid JSON");
  }
  if (!isStoredJournal(parsed)) {
    throw new Error("review effect journal has an invalid schema");
  }
  if (
    expected &&
    (parsed.candidateId !== expected.candidateId ||
      parsed.candidateDigest !== expected.candidateDigest)
  ) {
    throw new Error("review effect journal belongs to a different candidate");
  }
  if (containsSecretLikeContent(stableJson(parsed))) {
    throw new Error("review effect journal contains secret-shaped content");
  }
  return parsed;


}
function reviewDeliveryPlansMatch(
  current: ReviewAuthorizedDeliveryPlan,
  requested: ReviewAuthorizedDeliveryPlan,
): boolean {
  if (current.selectedFindingIds === undefined) {
    const legacy = { ...current };
    delete legacy.selectedFindingIds;
    const next = { ...requested };
    delete next.selectedFindingIds;
    return stableJson(legacy) === stableJson(next);
  }
  return stableJson(current) === stableJson(requested);
}

/** File-backed journal with durable intent-before-effect and idempotent effect IDs. */
export class FileReviewEffectJournalStore implements ReviewEffectJournalStore {
  #state: StoredJournal;

  private constructor(private readonly path: string, state: StoredJournal) {
    this.#state = state;
  }

  static async open(
    path: string,
    candidate: Pick<ReviewCandidate, "candidateId" | "candidateDigest">,
  ): Promise<FileReviewEffectJournalStore> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return new FileReviewEffectJournalStore(path, {
        schema: "shipwright-review-effects/v1",
        candidateId: candidate.candidateId,
        candidateDigest: candidate.candidateDigest,
        effects: [],
        resumeCursor: 0,
      });
    }
    const state = parseStoredJournal(raw);
    if (
      state.candidateId !== candidate.candidateId ||
      state.candidateDigest !== candidate.candidateDigest
    ) {
      throw new Error("review effect journal belongs to a different candidate");
    }
    return new FileReviewEffectJournalStore(path, state);
  }

  async load(): Promise<ReviewEffectReceipt[]> {
    const current = await this.readDisk();
    this.#state = current;
    return structuredClone(current.effects);
  }

  async beginEffect(
    input: Pick<ReviewEffectReceipt, "effectId" | "kind" | "idempotencyKey">,
  ): Promise<ReviewEffectReceipt> {
    return this.withExclusiveMutation((current) => {
      const existing = current.effects.find(
        (effect) => effect.effectId === input.effectId,
      );
      if (existing) {
        if (
          existing.kind !== input.kind ||
          existing.idempotencyKey !== input.idempotencyKey
        ) {
          throw new Error(`review effect ${input.effectId} does not match its existing intent`);
        }
        return { next: current, result: structuredClone(existing), persist: false };
      }
      const duplicate = current.effects.find(
        (effect) => effect.idempotencyKey === input.idempotencyKey,
      );
      if (duplicate) {
        throw new Error(
          `review effect idempotency key already belongs to ${duplicate.effectId}`,
        );
      }
      const effect: ReviewEffectReceipt = { ...input, status: "intent" };
      assertReviewEffectReceipt(effect);
      const next = { ...current, effects: [...current.effects, effect] };
      return { next, result: structuredClone(effect), persist: true };
    });
  }

  async ensureDeliveryPlan(plan: ReviewAuthorizedDeliveryPlan): Promise<ReviewAuthorizedDeliveryPlan> {
    assertReviewDeliveryPlan(plan);
    return this.withExclusiveMutation((current) => {
      if (plan.candidateDigest !== current.candidateDigest) {
        throw new Error("review delivery plan belongs to a different candidate");
      }
      if (current.deliveryPlan) {
        assertReviewDeliveryPlan(current.deliveryPlan);
        if (!reviewDeliveryPlansMatch(current.deliveryPlan, plan)) {
          throw new Error("review delivery plan changed after authorization");
        }
        return { next: current, result: structuredClone(current.deliveryPlan), persist: false };
      }
      if (current.effects.length > 0) {
        throw new Error("review delivery plan is missing before existing effects");
      }
      const next = { ...current, deliveryPlan: structuredClone(plan) };
      return { next, result: structuredClone(plan), persist: true };
    });
  }

  async ackEffect(
    input: Pick<ReviewEffectReceipt, "effectId"> &
      Partial<Omit<ReviewEffectReceipt, "effectId">>,
  ): Promise<ReviewEffectReceipt> {
    return this.withExclusiveMutation((current) => {
      const index = current.effects.findIndex(
        (effect) => effect.effectId === input.effectId,
      );
      if (index < 0) throw new Error(`unknown review effect ${input.effectId}`);
      const existing = current.effects[index]!;
      const acknowledged: ReviewEffectReceipt = {
        ...existing,
        ...input,
        effectId: existing.effectId,
        kind: existing.kind,
        idempotencyKey: existing.idempotencyKey,
        status: "confirmed",
      };
      if (containsSecretLikeContent(stableJson(acknowledged))) {
        throw new Error("review effect contains secret-shaped content");
      }
      assertReviewEffectReceipt(acknowledged);
      const effects = [...current.effects];
      effects[index] = acknowledged;
      const next = { ...current, effects };
      return { next, result: structuredClone(acknowledged), persist: true };
    });
  }

  async markAmbiguous(
    input: Pick<ReviewEffectReceipt, "effectId"> &
      Partial<Pick<ReviewEffectReceipt, "detail">>,
  ): Promise<ReviewEffectReceipt> {
    return this.withExclusiveMutation((current) => {
      const index = current.effects.findIndex(
        (effect) => effect.effectId === input.effectId,
      );
      if (index < 0) throw new Error(`unknown review effect ${input.effectId}`);
      const ambiguous: ReviewEffectReceipt = {
        ...current.effects[index]!,
        ...(input.detail === undefined ? {} : { detail: input.detail }),
        status: "ambiguous",
      };
      assertReviewEffectReceipt(ambiguous);
      const effects = [...current.effects];
      effects[index] = ambiguous;
      const next = { ...current, effects };
      return { next, result: structuredClone(ambiguous), persist: true };
    });
  }

  async getResumeCursor(): Promise<number> {
    const current = await this.readDisk();
    this.#state = current;
    return current.resumeCursor;
  }

  async setResumeCursor(cursor: number): Promise<void> {
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new Error("review effect resume cursor must be a non-negative integer");
    }
    await this.withExclusiveMutation((current) => {
      const next = { ...current, resumeCursor: cursor };
      return { next, result: undefined, persist: current.resumeCursor !== cursor };
    });
  }

  private async readDisk(): Promise<StoredJournal> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.#state;
      throw error;
    }
    return parseStoredJournal(raw, this.#state);
  }

  private async withExclusiveMutation<T>(
    mutator: (
      current: StoredJournal,
    ) =>
      | { next: StoredJournal; result: T; persist: boolean }
      | Promise<{ next: StoredJournal; result: T; persist: boolean }>,
  ): Promise<T> {
    return withNativeFileLock(reviewArtifactRootLock(effectArtifactRoot(this.path)), async (assertRootHeld) => {
      return withNativeFileLock(`${this.path}.lock`, async (assertHeld) => {
        const current = await this.readDisk();
        const mutation = await mutator(current);
        await assertRootHeld();
        await assertHeld();
        if (mutation.persist) await this.persist(mutation.next, assertHeld);
        this.#state = mutation.next;
        return mutation.result;
      });
    });
  }

  private async persist(state: StoredJournal, assertHeld?: () => Promise<void>): Promise<void> {
    if (!isStoredJournal(state)) {
      throw new Error("review effect journal has an invalid schema");
    }
    if (containsSecretLikeContent(stableJson(state))) {
      throw new Error("review effect journal contains secret-shaped content");
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await assertHeld?.();
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        mode: 0o600,
      });
      await assertHeld?.();
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

async function readStoredJournalFile(
  path: string,
  expected?: Pick<StoredJournal, "candidateId" | "candidateDigest">,
): Promise<StoredJournal | undefined> {
  try {
    return parseStoredJournal(await readFile(path, "utf8"), expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export interface ReviewArtifactPurgeOptions {
  /** Artifacts at or before this age are eligible unless they need recovery. */
  maxAgeMs: number;
  now?: Date | string;
  dryRun?: boolean;
}

export interface ReviewArtifactPurgeResult {
  cutoff: string;
  dryRun: boolean;
  scannedCandidates: number;
  eligibleCandidates: number;
  purgedCandidateIds: string[];
  purgedEffectJournalIds: string[];
  purgedVerificationRecordIds: string[];
  purgedVerificationPlanIds: string[];
  retainedCandidates: Array<{ candidateId: string; reason: string }>;
}

interface CandidateArtifactScan {
  candidateId: string;
  path: string;
  candidate: ReviewCandidate;
  journalPath: string;
  journal?: StoredJournal;
  eligible: boolean;
  reason?: string;
}

function hasUnresolvedReviewEffect(effects: readonly ReviewEffectReceipt[]): boolean {
  return effects.some((effect) => effect.status === "intent" || effect.status === "ambiguous");
}

function addRetainedCandidate(
  result: ReviewArtifactPurgeResult,
  candidateId: string,
  reason: string,
): void {
  if (!result.retainedCandidates.some((item) => item.candidateId === candidateId)) {
    result.retainedCandidates.push({ candidateId, reason });
  }
}

/**
 * Remove aged review artifacts without ever deleting recovery state. The
 * root lock serializes this sweep with candidate, verification, and effect
 * mutations. Per-record lock inodes are intentionally retained after a JSON
 * record is purged so no future process can observe an unlocked replacement.
 */
export async function purgeReviewArtifacts(
  root: string,
  options: ReviewArtifactPurgeOptions,
): Promise<ReviewArtifactPurgeResult> {
  if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) {
    throw new Error("review artifact max age must be a non-negative finite number");
  }
  const now = new Date(options.now ?? Date.now());
  if (Number.isNaN(now.getTime())) throw new Error("review artifact purge time is invalid");
  const cutoffMs = now.getTime() - options.maxAgeMs;
  const result: ReviewArtifactPurgeResult = {
    cutoff: new Date(cutoffMs).toISOString(),
    dryRun: options.dryRun === true,
    scannedCandidates: 0,
    eligibleCandidates: 0,
    purgedCandidateIds: [],
    purgedEffectJournalIds: [],
    purgedVerificationRecordIds: [],
    purgedVerificationPlanIds: [],
    retainedCandidates: [],
  };

  await withNativeFileLock(reviewArtifactRootLock(root), async (assertRootHeld) => {
    const candidateRoot = join(root, "review-candidates");
    let candidateEntries: Dirent[] = [];
    try {
      candidateEntries = await readdir(candidateRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const candidateIds = new Set(
      candidateEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
    const scans: CandidateArtifactScan[] = [];
    let unknownCandidateState = false;
    for (const entry of candidateEntries) {
      if (!entry.isDirectory()) continue;
      result.scannedCandidates += 1;
      let path: string;
      try {
        path = reviewCandidatePath(root, entry.name);
      } catch {
        unknownCandidateState = true;
        addRetainedCandidate(result, entry.name, "invalid-candidate-path");
        continue;
      }
      let candidate: ReviewCandidate;
      try {
        candidate = await withNativeFileLock(`${path}.lock`, async () => readReviewCandidate(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        unknownCandidateState = true;
        addRetainedCandidate(result, entry.name, "unreadable-candidate");
        continue;
      }
      candidateIds.add(candidate.candidateId);
      const journalPath = join(root, "review-effects", `${candidate.candidateId}.json`);
      let journal: StoredJournal | undefined;
      let journalError = false;
      try {
        journal = await readStoredJournalFile(journalPath, candidate);
      } catch {
        journalError = true;
      }
      const oldEnough = Date.parse(candidate.createdAt) <= cutoffMs;
      const unresolved =
        hasUnresolvedReviewEffect(candidate.effects) ||
        (journal !== undefined && hasUnresolvedReviewEffect(journal.effects));
      const reason = unresolved
        ? "unresolved-or-ambiguous-effect"
        : journalError
          ? "unreadable-effect-journal"
          : candidate.effects.length > 0 && journal === undefined
            ? "missing-effect-journal"
            : oldEnough
              ? undefined
              : "within-retention-window";
      if (reason) addRetainedCandidate(result, candidate.candidateId, reason);
      else result.eligibleCandidates += 1;
      scans.push({
        candidateId: candidate.candidateId,
        path,
        candidate,
        journalPath,
        journal,
        eligible: reason === undefined,
        reason,
      });
    }

    if (!options.dryRun) {
      for (const scan of scans) {
        if (!scan.eligible) continue;
        let purged = false;
        try {
          await withNativeFileLock(scan.path + ".lock", async (assertHeld) => {
            const latest = await readReviewCandidate(scan.path);
            if (
              latest.candidateDigest !== scan.candidate.candidateDigest ||
              latest.createdAt !== scan.candidate.createdAt ||
              Date.parse(latest.createdAt) > cutoffMs
            ) {
              addRetainedCandidate(result, scan.candidateId, "changed-during-purge");
              return;
            }
            const removeCandidate = async (journal?: StoredJournal) => {
              const unresolved =
                hasUnresolvedReviewEffect(latest.effects) ||
                (journal !== undefined && hasUnresolvedReviewEffect(journal.effects));
              if (unresolved || (latest.effects.length > 0 && journal === undefined)) {
                addRetainedCandidate(
                  result,
                  scan.candidateId,
                  unresolved ? "unresolved-or-ambiguous-effect" : "missing-effect-journal",
                );
                return;
              }
              await assertRootHeld();
              await assertHeld();
              await rm(scan.path, { force: true });
              if (journal !== undefined) {
                await rm(scan.journalPath, { force: true });
                result.purgedEffectJournalIds.push(scan.candidateId);
              }
              purged = true;
            };
            if (scan.journal === undefined) {
              await removeCandidate();
              return;
            }
            await withNativeFileLock(scan.journalPath + ".lock", async (assertJournalHeld) => {
              const journal = await readStoredJournalFile(scan.journalPath, latest);
              await assertJournalHeld();
              await removeCandidate(journal);
            });
          });
        } catch {
          addRetainedCandidate(result, scan.candidateId, "changed-during-purge");
        }
        if (purged) result.purgedCandidateIds.push(scan.candidateId);
      }
    }

    if (!options.dryRun) {
      const effectRoot = join(root, "review-effects");
      let effectEntries: Dirent[] = [];
      try {
        effectEntries = await readdir(effectRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const entry of effectEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const candidateId = entry.name.slice(0, -".json".length);
        if (candidateIds.has(candidateId)) continue;
        const journalPath = join(effectRoot, entry.name);
        let journalStat;
        try {
          journalStat = await stat(journalPath);
        } catch {
          continue;
        }
        if (journalStat.mtimeMs > cutoffMs) {
          addRetainedCandidate(result, candidateId, "within-retention-window");
          continue;
        }
        try {
          await withNativeFileLock(`${journalPath}.lock`, async (assertHeld) => {
            let latestStat;
            try {
              latestStat = await stat(journalPath);
            } catch {
              return;
            }
            if (latestStat.mtimeMs > cutoffMs) {
              addRetainedCandidate(result, candidateId, "within-retention-window");
              return;
            }
            let journal: StoredJournal | undefined;
            try {
              journal = await readStoredJournalFile(journalPath);
            } catch {
              return;
            }
            if (journal === undefined) return;
            if (hasUnresolvedReviewEffect(journal.effects)) {
              addRetainedCandidate(
                result,
                journal.candidateId,
                "unresolved-or-ambiguous-effect",
              );
              return;
            }
            await assertRootHeld();
            await assertHeld();
            await rm(journalPath, { force: true });
            result.purgedEffectJournalIds.push(journal.candidateId);
          });
        } catch {
          // Leave malformed or concurrently changing orphan journals in place.
        }
      }
    }

    if (options.dryRun) return;

    const retainedRecordIds = new Set<string>();
    const retainedCandidateDigests = new Set<string>();
    let unknownRemainingCandidate = unknownCandidateState;
    let remainingEntries: Dirent[] = [];
    try {
      remainingEntries = await readdir(candidateRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") remainingEntries = [];
      else throw error;
    }
    for (const entry of remainingEntries) {
      if (!entry.isDirectory()) continue;
      let path: string;
      try {
        path = reviewCandidatePath(root, entry.name);
      } catch {
        unknownRemainingCandidate = true;
        continue;
      }
      try {
        const candidate = await withNativeFileLock(`${path}.lock`, async () => readReviewCandidate(path));
        retainedCandidateDigests.add(candidate.candidateDigest);
        for (const token of candidate.verificationRecords) retainedRecordIds.add(token.recordId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") unknownRemainingCandidate = true;
      }
    }

    if (!unknownRemainingCandidate) {
      const verificationRoot = join(root, "review-verifications");
      let entries: Dirent[] = [];
      try {
        entries = await readdir(verificationRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
        else throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const path = join(verificationRoot, entry.name);
        let record: ReviewFindingVerificationRecord;
        try {
          record = JSON.parse(await readFile(path, "utf8")) as ReviewFindingVerificationRecord;
          validateReviewVerificationRecord(record);
        } catch {
          continue;
        }
        if (
          retainedRecordIds.has(record.recordId) ||
          Date.parse(record.createdAt) > cutoffMs
        ) continue;
        await withNativeFileLock(`${path}.lock`, async (assertHeld) => {
          let latest: ReviewFindingVerificationRecord;
          try {
            latest = JSON.parse(await readFile(path, "utf8")) as ReviewFindingVerificationRecord;
            validateReviewVerificationRecord(latest);
          } catch {
            return;
          }
          if (
            retainedRecordIds.has(latest.recordId) ||
            Date.parse(latest.createdAt) > cutoffMs
          ) return;
          await assertRootHeld();
          await assertHeld();
          await rm(path, { force: true });
          result.purgedVerificationRecordIds.push(latest.recordId);
        });
      }
    }

    const planRoot = join(root, "review-verification-plans");
    let planEntries: Dirent[] = [];
    try {
      planEntries = await readdir(planRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") planEntries = [];
      else throw error;
    }
    if (!unknownRemainingCandidate) {
      for (const digestEntry of planEntries) {
        if (!digestEntry.isDirectory() || !/^[0-9a-f]{64}$/.test(digestEntry.name)) continue;
        if (retainedCandidateDigests.has(digestEntry.name)) continue;
        let files: Dirent[] = [];
        try {
          files = await readdir(join(planRoot, digestEntry.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith(".json")) continue;
          const path = join(planRoot, digestEntry.name, file.name);
          let plan: ReviewVerificationPlan;
          try {
            plan = JSON.parse(await readFile(path, "utf8")) as ReviewVerificationPlan;
            assertReviewVerificationPlanShape(plan);
          } catch {
            continue;
          }
          if (
            plan.candidateDigest !== digestEntry.name ||
            Date.parse(plan.createdAt) > cutoffMs
          ) continue;
          await withNativeFileLock(`${path}.lock`, async (assertHeld) => {
            let latest: ReviewVerificationPlan;
            try {
              latest = JSON.parse(await readFile(path, "utf8")) as ReviewVerificationPlan;
              assertReviewVerificationPlanShape(latest);
            } catch {
              return;
            }
            if (
              latest.candidateDigest !== digestEntry.name ||
              retainedCandidateDigests.has(latest.candidateDigest) ||
              Date.parse(latest.createdAt) > cutoffMs
            ) return;
            await assertRootHeld();
            await assertHeld();
            await rm(path, { force: true });
            result.purgedVerificationPlanIds.push(`${digestEntry.name}/${file.name}`);
          });
        }
      }
    }
  });
  return result;
}
