import { expect, test } from "bun:test";
import { parseReviewOutcomes } from "../../src/pipeline/review-outcomes.js";

const artifact = (threads: unknown[]) => JSON.stringify({ threads });

test("accepts exactly one justified outcome per authorized thread", () => {
  expect(parseReviewOutcomes(artifact([
    { threadId: "t1", outcome: "fixed", summary: "Added guard", evidence: "src/a.ts:4" },
    { threadId: "t2", outcome: "rejected", summary: "Already guarded", evidence: "src/b.ts:8" },
  ]), ["t1", "t2"], ["src/a.ts"])).toHaveLength(2);
});

test("rejects missing, duplicate, unknown, and unsupported no-code outcomes", () => {
  expect(() => parseReviewOutcomes(artifact([]), ["t1"])).toThrow("missing review threads");
  expect(() => parseReviewOutcomes(artifact([
    { threadId: "t1", outcome: "rejected", summary: "x", evidence: "y" },
    { threadId: "t1", outcome: "rejected", summary: "x", evidence: "y" },
  ]), ["t1"])).toThrow("duplicate review thread");
  expect(() => parseReviewOutcomes(artifact([
    { threadId: "other", outcome: "rejected", summary: "x", evidence: "y" },
  ]), ["t1"])).toThrow("unknown review thread");
  expect(() => parseReviewOutcomes(artifact([
    { threadId: "t1", outcome: "fixed", summary: "x", evidence: "y" },
  ]), ["t1"], [])).toThrow("require a repository change");
});

test("requires a concrete follow-up for deferred outcomes", () => {
  expect(() => parseReviewOutcomes(artifact([
    { threadId: "t1", outcome: "deferred", summary: "later", evidence: "out of scope" },
  ]), ["t1"])).toThrow("requires a follow-up");
});
