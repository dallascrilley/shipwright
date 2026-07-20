import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunExecution } from "./receipt.js";
import { redactSecrets } from "./receipt.js";
import type { ReviewOutcome } from "./review-outcomes.js";

export type ReviewRunPhase = "intake" | "workspace" | "agent" | "verify" | "policy" | "publish" | "threads" | "complete";

export interface ReviewThreadResult {
  threadId: string;
  outcome: ReviewOutcome["outcome"];
  replyUrl: string;
  resolved: boolean;
}

export interface ReviewRunReceipt {
  runId: string;
  phase: ReviewRunPhase;
  pullRequestUrl: string;
  execution: RunExecution;
  skill: { name: "fix-review-findings"; sha256: string };
  authorizedHeadSha?: string;
  headBranch?: string;
  changedFiles: string[];
  verification: {
    command: string;
    exitCode: number | null;
    passed: boolean;
    stdoutTail?: string;
    stderrTail?: string;
  };
  commitSha?: string;
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
