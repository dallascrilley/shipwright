import { expect, test } from "bun:test";
import { findMarkedReply, replyAnchorId, reviewReplyMarker, unresolvedCurrentThreads } from "../../src/github/review-client.js";
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

test("a thread with nothing but our own comments anchors on the thread", () => {
  expect(replyAnchorId(thread({ comments: [] }))).toBe("thread-1");
  expect(replyAnchorId(thread({ comments: [ours("comment-1")] }))).toBe("thread-1");
});

test("filters resolved and outdated threads", () => {
  expect(unresolvedCurrentThreads([
    thread(),
    thread({ id: "resolved", isResolved: true }),
    thread({ id: "outdated", isOutdated: true }),
  ]).map((item) => item.id)).toEqual(["thread-1"]);
});
