import { createHash } from "node:crypto";
import type { ReviewComment, ReviewThread } from "./types.js";

export const reviewRunMarker = (runId: string, threadId: string): string =>
  `<!-- agentos-review-run:${runId} thread:${threadId} -->`;

export function isGeneratedReviewReply(
  comment: Pick<ReviewComment, "body">,
  threadId: string,
): boolean {
  const markerPrefix = "<!-- agentos-review-run:";
  const markerSuffix = ` thread:${threadId} -->`;
  const body = comment.body.trimEnd();
  const markerStart = body.lastIndexOf(markerPrefix);
  if (
    markerStart <= 0
    || !body.endsWith(markerSuffix)
    || !body.slice(0, markerStart).trim()
    || body.slice(markerStart - 2, markerStart) !== "\n\n"
  ) {
    return false;
  }
  const runId = body.slice(
    markerStart + markerPrefix.length,
    body.length - markerSuffix.length,
  );
  return runId.length > 0 && !/\s/.test(runId);
}

export function findMarkedReply(
  thread: ReviewThread,
  runId: string,
): { url: string } | undefined {
  const marker = reviewRunMarker(runId, thread.id);
  const comment = thread.comments.find(
    (candidate) =>
      isGeneratedReviewReply(candidate, thread.id) &&
      candidate.body.trimEnd().endsWith(marker),
  );
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
      .filter((comment) => !isGeneratedReviewReply(comment, thread.id))
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
