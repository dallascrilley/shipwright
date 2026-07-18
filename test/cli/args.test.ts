import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/cli/args.js";

describe("parseArgs", () => {
  test("defaults to dry run and parses explicit verification", () => {
    expect(
      parseArgs(["https://github.com/owner/repo/issues/4", "--verify", "bun test"]),
    ).toEqual({
      issueUrl: "https://github.com/owner/repo/issues/4",
      verifyCommand: "bun test",
      publish: false,
      timeoutMinutes: 30,
    });
  });

  test("enables publication only with the explicit flag", () => {
    expect(
      parseArgs([
        "https://github.com/owner/repo/issues/4",
        "--verify",
        "bun test",
        "--publish",
        "--timeout-minutes",
        "12",
      ]),
    ).toMatchObject({ publish: true, timeoutMinutes: 12 });
  });

  test("rejects missing input and invalid timeout", () => {
    expect(() => parseArgs([])).toThrow("Usage");
    expect(() => parseArgs(["url", "--verify", "bun test", "--timeout-minutes", "0"])).toThrow(
      "timeout",
    );
  });
});
