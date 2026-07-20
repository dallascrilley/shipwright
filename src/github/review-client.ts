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

export function unresolvedCurrentThreads(threads: ReviewThread[]): ReviewThread[] {
  return threads.filter((thread) => !thread.isResolved && !thread.isOutdated);
}
