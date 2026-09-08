import { createHash } from "node:crypto";
import type { ReviewThread } from "./types.js";

export const reviewRunMarker = (runId: string, threadId: string): string =>
  `<!-- agentos-review-run:${runId} thread:${threadId} -->`;

export function findMarkedReply(
  thread: ReviewThread,
  runId: string,
): { url: string } | undefined {
  const marker = reviewRunMarker(runId, thread.id);
  const comment = thread.comments.find((candidate) => candidate.body.includes(marker));
  return comment ? { url: comment.url } : undefined;
}

/**
 * Stable identity for the original review discussion. Shipwright-generated
 * receipt comments are deliberately excluded so retries cannot change the
 * finding binding after an effect has succeeded.
 */
export function reviewThreadContentDigest(thread: ReviewThread): string {
  const snapshot = {
    id: thread.id,
    path: thread.path,
    line: thread.line,
    comments: thread.comments
      .filter((comment) => !comment.body.includes("agentos-review-run:"))
      .map((comment) => ({
        id: comment.id,
        body: comment.body,
        url: comment.url,
        author: comment.author,
      })),
  };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function unresolvedCurrentThreads(threads: ReviewThread[]): ReviewThread[] {
  return threads.filter((thread) => !thread.isResolved && !thread.isOutdated);
}
