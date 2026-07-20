import { describe, expect, test } from "vitest";

import { operatorRunRequestSchema } from "./operator-run";

const validInput = {
  mode: "issue" as const,
  issueUrl: "https://github.com/dallascrilley/example/issues/12",
  verifyCommand: "bun test",
  timeoutMinutes: 30,
};

describe("operatorRunRequestSchema", () => {
  test("defaults to a dry run", () => {
    const result = operatorRunRequestSchema.parse(validInput);

    expect(result.publish).toBe(false);
    expect(result.publishConfirmed).toBe(false);
  });

  test("defaults timeoutMinutes to 30 when omitted", () => {
    const { timeoutMinutes: _ignored, ...withoutTimeout } = validInput;
    const result = operatorRunRequestSchema.parse(withoutTimeout);
    expect(result.timeoutMinutes).toBe(30);
  });

  test("requires explicit confirmation before publishing", () => {
    const result = operatorRunRequestSchema.safeParse({
      ...validInput,
      publish: true,
    });

    expect(result.success).toBe(false);
  });

  test("rejects a non-canonical issue URL", () => {
    const result = operatorRunRequestSchema.safeParse({
      ...validInput,
      issueUrl: "https://example.com/issues/12",
    });

    expect(result.success).toBe(false);
  });
});

  test("review mode requires a pull request URL and skill path", () => {
    const missing = operatorRunRequestSchema.safeParse({
      mode: "review",
      verifyCommand: "bun test",
    });
    expect(missing.success).toBe(false);

    const valid = operatorRunRequestSchema.parse({
      mode: "review",
      pullRequestUrl: "https://github.com/dallascrilley/example/pull/9",
      skillPath: "/tmp/fix-review-findings/SKILL.md",
      verifyCommand: "bun test",
    });
    expect(valid.mode).toBe("review");
    expect(valid.pullRequestUrl).toContain("/pull/9");
  });
