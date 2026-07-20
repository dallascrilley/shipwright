import { expect, test } from "bun:test";
import { parseReviewArgs } from "../../src/cli/review-args.js";

test("parses a publish review run", () => {
  expect(parseReviewArgs([
    "https://github.com/acme/widget/pull/4",
    "--verify", "bun test",
    "--skill", "/skills/fix-review-findings/SKILL.md",
    "--publish",
    "--timeout-minutes", "10",
  ])).toEqual({
    pullRequestUrl: "https://github.com/acme/widget/pull/4",
    verifyCommand: "bun test",
    skillPath: "/skills/fix-review-findings/SKILL.md",
    publish: true,
    timeoutMinutes: 10,
  });
});

test("requires verification and skill paths", () => {
  expect(() => parseReviewArgs(["https://github.com/acme/widget/pull/4", "--verify", "bun test"])).toThrow("--skill");
  expect(() => parseReviewArgs(["https://github.com/acme/widget/pull/4", "--skill", "/skill"])).toThrow("--verify");
});
