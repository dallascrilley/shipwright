import { expect, test } from "bun:test";
import {
  findMarkedReply,
  reviewRunMarker,
  reviewThreadContentDigest,
  unresolvedCurrentThreads,
} from "../../src/github/review-client.js";
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

test("finds an existing run marker reply", () => {
  const marker = reviewRunMarker("run-1", "thread-1");
  expect(findMarkedReply(thread({
    comments: [{ id: "comment-1", body: `Addressed.\n\n${marker}`, url: "https://example/reply", author: "bot" }],
  }), "run-1")).toEqual({ url: "https://example/reply" });
});
test("ignores reviewer comments that only mention the receipt marker", () => {
  const marker = reviewRunMarker("run-1", "thread-1");
  expect(findMarkedReply(thread({
    comments: [{
      id: "comment-2",
      body: `A reviewer mentioned ${marker} in ordinary prose.`,
      url: "https://example/reviewer",
      author: "reviewer",
    }],
  }), "run-1")).toBeUndefined();
});

test("does not treat a marker-only comment as generated", () => {
  const marker = reviewRunMarker("run-1", "thread-1");
  expect(findMarkedReply(thread({
    comments: [{
      id: "comment-3",
      body: marker,
      url: "https://example/reviewer",
      author: "reviewer",
    }],
  }), "run-1")).toBeUndefined();
});


test("keeps substantive marker mentions in the review digest", () => {
  const original = thread({
    comments: [{
      id: "comment-1",
      body: "The prior <!-- agentos-review-run:old thread:thread-1 --> remains relevant.",
      url: "https://example/comment",
      author: "reviewer",
    }],
  });
  expect(reviewThreadContentDigest(original)).not.toBe(
    reviewThreadContentDigest(thread()),
  );
});

test("excludes generated replies from the review digest", () => {
  const original = {
    id: "comment-1",
    body: "Please add a guard.",
    url: "https://example/comment",
    author: "reviewer",
  };
  const generated = {
    id: "comment-2",
    body: `Addressed.\n\n${reviewRunMarker("run-1", "thread-1")}`,
    url: "https://example/reply",
    author: "shipwright",
  };
  const withoutReply = thread({ comments: [original] });
  const withReply = thread({ comments: [original, generated] });
  expect(reviewThreadContentDigest(withReply)).toBe(
    reviewThreadContentDigest(withoutReply),
  );
});

test("filters resolved and outdated threads", () => {
  expect(unresolvedCurrentThreads([
    thread(),
    thread({ id: "resolved", isResolved: true }),
    thread({ id: "outdated", isOutdated: true }),
  ]).map((item) => item.id)).toEqual(["thread-1"]);
});
