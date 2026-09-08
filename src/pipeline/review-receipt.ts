import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunExecution } from "./receipt.js";
import { redactSecrets } from "./receipt.js";
import type { ReviewOutcome } from "./review-outcomes.js";

export type ReviewRunPhase = "intake" | "workspace" | "agent" | "verify" | "policy" | "publish" | "threads" | "complete";

export interface ReviewThreadResult {
  threadId: string;
  /** Model proposal, retained for audit but never used as closure authority. */
  outcome: ReviewOutcome["outcome"];
  proposedOutcome: ReviewOutcome["outcome"];
  verifiedDisposition:
    | "fixed"
    | "deferred"
    | "rejected"
    | "already-addressed"
    | "needs-human"
    | "pending";
  verificationStatus: "verified" | "pending" | "not-required";
  verificationReason?: string;
  verificationRecordId?: string;
  replyUrl: string;
  resolved: boolean;
}

export interface ReviewRunReceipt {
  runId: string;
  phase: ReviewRunPhase;
  pullRequestUrl: string;
  execution: RunExecution;
  skill: { name: "fix-review-findings"; sha256: string };
  authorizedBaseSha?: string;
  authorizedHeadSha?: string;
  headBranch?: string;
  candidateId?: string;
  candidateDigest?: string;
  deliveryMode: "patch" | "commit" | "follow-up-pr" | "evidence-only";
  changedFiles: string[];
  verification: {
    command: string;
    exitCode: number | null;
    passed: boolean;
    stdoutTail?: string;
    stderrTail?: string;
  };
  commitSha?: string;
  followUpPullRequestUrl?: string;
  threadResults: ReviewThreadResult[];
  remainingOpenThreadIds: string[];
  errorCode?: string;
  errorMessage?: string;
}

export async function writeReviewReceipt(path: string, receipt: ReviewRunReceipt): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const serialized = redactSecrets(`${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(temporaryPath, serialized, { mode: 0o600 });
  await rename(temporaryPath, path);
}
