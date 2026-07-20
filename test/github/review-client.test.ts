import { expect, test } from "bun:test";
import { findMarkedReply, reviewRunMarker, unresolvedCurrentThreads } from "../../src/github/review-client.js";
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
    comments: [{ id: "comment-1", body: `${marker}\nAddressed`, url: "https://example/reply", author: "bot" }],
  }), "run-1")).toEqual({ url: "https://example/reply" });
});

test("filters resolved and outdated threads", () => {
  expect(unresolvedCurrentThreads([
    thread(),
    thread({ id: "resolved", isResolved: true }),
    thread({ id: "outdated", isOutdated: true }),
  ]).map((item) => item.id)).toEqual(["thread-1"]);
});
