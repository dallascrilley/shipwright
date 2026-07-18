import { describe, expect, test } from "bun:test";
import { parseNulList, requireSuccessfulCommand } from "../../src/sandbox/runtime.js";

describe("sandbox command helpers", () => {
  test("parses NUL-delimited git output", () => {
    expect(parseNulList("src/a.ts\0README.md\0")).toEqual(["src/a.ts", "README.md"]);
  });

  test("rejects nonzero, timed out, and truncated commands", () => {
    expect(() =>
      requireSuccessfulCommand("test", {
        exitCode: 1,
        stdout: "",
        stderr: "failed",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        durationMs: 1,
      }),
    ).toThrow("failed");
    expect(() =>
      requireSuccessfulCommand("test", {
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: true,
        durationMs: 1,
      }),
    ).toThrow("timed out");
  });
});
