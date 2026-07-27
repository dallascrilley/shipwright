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

/**
 * Matched at the start of a line, never anywhere in the body. GitHub's quote-reply
 * copies the whole comment, marker included, prefixed with "> ". A substring match
 * would read that human follow-up as one of ours and refuse to answer it -- the
 * one moment a reply is most clearly wanted.
 */
function hasMarkerLine(body: string, marker: string): boolean {
  return body.split("\n").some((line) => line.startsWith(marker));
}

export function isPipelineReply(comment: ReviewComment): boolean {
  return hasMarkerLine(comment.body, REPLY_MARKER_PREFIX);
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
  const comment = thread.comments.find((candidate) => hasMarkerLine(candidate.body, marker));
  return comment ? { url: comment.url } : undefined;
}

/** The comment a reply is answering, so the reply can quote what it responds to. */
export function anchorComment(thread: ReviewThread, anchorCommentId: string): ReviewComment | undefined {
  return thread.comments.find((comment) => comment.id === anchorCommentId);
}

export function unresolvedCurrentThreads(threads: ReviewThread[]): ReviewThread[] {
  return threads.filter((thread) => !thread.isResolved && !thread.isOutdated);
}
