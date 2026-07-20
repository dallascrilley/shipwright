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
      "rivetdev/sandbox-agent@sha256:640cfb725a94b8a47967e0c2ec153d3ab267244f517f700e8f82f1e4d55b2ea2",
    );
    expect(
      resolveSandboxImage(
        " registry.example.com/shipwright@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ",
      ),
    ).toBe(
      "registry.example.com/shipwright@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(() => resolveSandboxImage("registry.example.com/shipwright:latest")).toThrow(
      "immutable sha256 digest",
    );
  });
});
