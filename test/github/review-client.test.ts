import { expect, test } from "bun:test";
import { anchorComment, findMarkedReply, isPipelineReply, replyAnchorId, reviewReplyMarker, unresolvedCurrentThreads } from "../../src/github/review-client.js";
import type { ReviewThread } from "../../src/github/types.js";

const thread = (overrides: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "thread-1",
  isResolved: false,
  isOutdated: false,
  path: "src/a.ts",
  line: 7,
  comments: [],
  ...overrides,
});

const human = (id: string) => ({ id, body: "Please add a guard", url: `https://example/${id}`, author: "reviewer" });
const ours = (anchorId: string) => ({
  id: `reply-to-${anchorId}`,
  body: `Addressed\n\n${reviewReplyMarker("thread-1", anchorId)}`,
  url: "https://example/reply",
  author: "shipwright[bot]",
});

test("finds our reply to a given anchor comment", () => {
  const marked = thread({ comments: [human("comment-1"), ours("comment-1")] });
  expect(findMarkedReply(marked, "comment-1")).toEqual({ url: "https://example/reply" });
  // A newer human comment is a different anchor, so the old reply does not count
  // as having answered it.
  expect(findMarkedReply(marked, "comment-2")).toBeUndefined();
});

test("the anchor is the newest comment we did not write", () => {
  expect(replyAnchorId(thread({ comments: [human("comment-1")] }))).toBe("comment-1");
  expect(replyAnchorId(thread({ comments: [human("comment-1"), ours("comment-1")] }))).toBe("comment-1");
  expect(replyAnchorId(thread({
    comments: [human("comment-1"), ours("comment-1"), human("comment-2")],
  }))).toBe("comment-2");
});

test("a human quoting our reply is still a human comment", () => {
  // GitHub's quote-reply copies the whole body, marker included, with "> " in
  // front of every line. That follow-up is the clearest possible signal that a
  // reply is wanted, so it must not read as one of ours.
  const quoted = {
    id: "comment-2",
    body: `> Addressed\n> ${reviewReplyMarker("thread-1", "comment-1")}\n\nStill broken`,
    url: "https://example/comment-2",
    author: "reviewer",
  };
  expect(isPipelineReply(quoted)).toBe(false);
  const marked = thread({ comments: [human("comment-1"), ours("comment-1"), quoted] });
  expect(replyAnchorId(marked)).toBe("comment-2");
  expect(findMarkedReply(marked, "comment-2")).toBeUndefined();
});

test("a thread with nothing but our own comments anchors on the thread", () => {
  expect(replyAnchorId(thread({ comments: [] }))).toBe("thread-1");
  expect(replyAnchorId(thread({ comments: [ours("comment-1")] }))).toBe("thread-1");
});

test("anchorComment resolves the comment a reply answers", () => {
  const marked = thread({ comments: [human("comment-1"), human("comment-2")] });
  expect(anchorComment(marked, "comment-2")?.id).toBe("comment-2");
  // The thread-id fallback anchor names no comment, so callers must handle it.
  expect(anchorComment(marked, "thread-1")).toBeUndefined();
});

test("filters resolved and outdated threads", () => {
  expect(unresolvedCurrentThreads([
    thread(),
    thread({ id: "resolved", isResolved: true }),
    thread({ id: "outdated", isOutdated: true }),
  ]).map((item) => item.id)).toEqual(["thread-1"]);
});
