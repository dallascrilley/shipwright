import { describe, expect, test } from "vitest";

import { operatorRunRequestSchema } from "./operator-run";

const validInput = {
  issueUrl: "https://github.com/dallascrilley/example/issues/12",
  verifyCommand: "bun test",
  timeoutMinutes: 20,
};

describe("operatorRunRequestSchema", () => {
  test("defaults to a dry run", () => {
    const result = operatorRunRequestSchema.parse(validInput);

    expect(result.publish).toBe(false);
    expect(result.publishConfirmed).toBe(false);
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
