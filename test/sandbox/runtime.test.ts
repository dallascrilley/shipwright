import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseNulList,
  requireSuccessfulCommand,
  resolveSandboxContainerUser,
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

  test("matches the sandbox container user to the Linux host workspace owner", () => {
    expect(resolveSandboxContainerUser("linux", 996, 988)).toBe("996:988");
    expect(resolveSandboxContainerUser("darwin", 501, 20)).toBeUndefined();
    expect(resolveSandboxContainerUser("linux", undefined, undefined)).toBeUndefined();
  });

  test("host temp workspaces resolve through macOS private tmp symlinks", async () => {
    const created = await mkdtemp(join(tmpdir(), "shipwright-workspace-"));
    try {
      const resolved = await realpath(created);
      expect(resolved.startsWith("/private/") || resolved === created).toBe(true);
      expect(resolved.includes("shipwright-workspace-")).toBe(true);
    } finally {
      await rm(created, { recursive: true, force: true });
    }
  });

  test("home-local workspace roots stay outside /var/folders", async () => {
    const root = join(homedir(), ".shipwright", "workspaces");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const created = await mkdtemp(join(root, "run-"));
    try {
      const resolved = await realpath(created);
      expect(resolved.includes("/var/folders/")).toBe(false);
      expect(resolved.includes(".shipwright/workspaces")).toBe(true);
    } finally {
      await rm(created, { recursive: true, force: true });
    }
  });
});
