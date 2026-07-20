import { z } from "zod";

const outcomeSchema = z.object({
  threadId: z.string().min(1),
  outcome: z.enum(["fixed", "deferred", "rejected", "needs-human"]),
  summary: z.string().min(1).max(2_000),
  evidence: z.string().min(1).max(2_000),
  followUp: z.string().min(1).max(1_000).optional(),
}).strict();

const artifactSchema = z.object({
  threads: z.array(outcomeSchema),
}).strict();

export type ReviewOutcome = z.infer<typeof outcomeSchema>;

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
