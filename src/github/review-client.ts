import type { ReviewComment, ReviewThread } from "./types.js";

/**
 * Identifies a comment this pipeline wrote. Kept separate from the full marker so
 * a later run can recognize its own replies without knowing what they answered.
 */
const REPLY_MARKER_PREFIX = "<!-- agentos-review-reply";

/**
 * Keyed by the comment being answered, not by the run that answered it. A run id
 * changes on every execution, so a thread the pipeline leaves unresolved
 * (`needs-human`) collects one more identical reply per wake. The anchor is
 * stable until a human actually says something new, which is exactly when
 * another reply is warranted.
 */
export const reviewReplyMarker = (threadId: string, anchorCommentId: string): string =>
  `${REPLY_MARKER_PREFIX} thread:${threadId} anchor:${anchorCommentId} -->`;

export function isPipelineReply(comment: ReviewComment): boolean {
  return comment.body.includes(REPLY_MARKER_PREFIX);
}

/**
 * The newest comment the pipeline did not write itself -- the thing a reply would
 * be answering. Falls back to the thread id when every comment is ours or the
 * thread is empty: that degrades to one reply per thread, which under-replies
 * rather than loops.
 */
export function replyAnchorId(thread: ReviewThread): string {
  for (let index = thread.comments.length - 1; index >= 0; index -= 1) {
    const comment = thread.comments[index]!;
    if (!isPipelineReply(comment)) return comment.id;
  }
  return thread.id;
}

export function findMarkedReply(
  thread: ReviewThread,
  anchorCommentId: string,
): { url: string } | undefined {
  const marker = reviewReplyMarker(thread.id, anchorCommentId);
  const comment = thread.comments.find((candidate) => candidate.body.includes(marker));
  return comment ? { url: comment.url } : undefined;
}

export function unresolvedCurrentThreads(threads: ReviewThread[]): ReviewThread[] {
  return threads.filter((thread) => !thread.isResolved && !thread.isOutdated);
}
