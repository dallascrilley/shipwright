import { expect, test } from "bun:test";
import { parseReviewArgs } from "../../src/cli/review-args.js";

test("parses a publish review run with local-owner authorization", () => {
  const parsed = parseReviewArgs([
    "https://github.com/acme/widget/pull/4",
    "--verify", "bun test",
    "--skill", "/skills/fix-review-findings/SKILL.md",
    "--publish",
    "--owner-id", "acme",
    "--timeout-minutes", "10",
  ]);
  expect(parsed).toEqual({
    pullRequestUrl: "https://github.com/acme/widget/pull/4",
    verifyCommand: "bun test",
    skillPath: "/skills/fix-review-findings/SKILL.md",
    publish: true,
    ownership: {
      mode: "local-owner",
      ownerId: "acme",
      source: "operator",
    },
    timeoutMinutes: 10,
  });
  expect(parsed.deliveryMode).toBeUndefined();
});

test("parses explicit handoff authorization for direct publication", () => {
  expect(parseReviewArgs([
    "https://github.com/acme/widget/pull/4",
    "--verify", "bun test",
    "--skill", "/skill",
    "--publish",
    "--delivery-mode", "commit",
    "--owner-id", "shipwright",
    "--handoff-from-owner", "acme",
    "--handoff-id", "handoff-4",
    "--authorized-by", "operator",
  ]).ownership).toEqual({
    mode: "explicit-handoff",
    ownerId: "shipwright",
    fromOwnerId: "acme",
    handoffId: "handoff-4",
    authorizedBy: "operator",
    source: "operator",
  });
  expect(() => parseReviewArgs([
    "https://github.com/acme/widget/pull/4",
    "--verify", "bun test",
    "--skill", "/skill",
    "--publish",
    "--delivery-mode", "commit",
    "--owner-id", "acme",
  ])).toThrow("explicit ownership handoff");
});

test("accepts only explicit native delivery modes", () => {
  expect(parseReviewArgs([
    "https://github.com/acme/widget/pull/4",
    "--verify", "bun test",
    "--skill", "/skill",
    "--delivery-mode", "follow-up-pr",
  ]).deliveryMode).toBe("follow-up-pr");
  expect(() => parseReviewArgs([
    "https://github.com/acme/widget/pull/4",
    "--verify", "bun test",
    "--skill", "/skill",
    "--delivery-mode", "followup",
  ])).toThrow("invalid delivery mode");
});

test("requires verification and skill paths", () => {
  expect(() => parseReviewArgs(["https://github.com/acme/widget/pull/4", "--verify", "bun test"])).toThrow("--skill");
  expect(() => parseReviewArgs(["https://github.com/acme/widget/pull/4", "--skill", "/skill"])).toThrow("--verify");
});
