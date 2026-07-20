import { describe, expect, test } from "bun:test";
import {
  parseNulList,
  requireSuccessfulCommand,
  resolveSandboxImage,
} from "../../src/sandbox/runtime.js";

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

  test("resolves the pinned sandbox image", () => {
    expect(resolveSandboxImage(undefined)).toBe(
      "rivetdev/sandbox-agent:0.5.0-rc.2-full",
    );
    expect(resolveSandboxImage(" registry.example.com/shipwright:sandbox ")).toBe(
      "registry.example.com/shipwright:sandbox",
    );
  });
});
