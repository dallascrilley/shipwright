import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPECTED_SANDBOX_BUN_VERSION,
  requireExpectedBunVersion,
  parseNulList,
  requireSuccessfulCommand,
  resolveBunExecutable,
  resolvePiNodeModulesDirectory,
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

  test("maps the sandbox user for rootful and rootless Docker", () => {
    expect(resolveSandboxContainerUser("linux", 996, 988, "rootful")).toBe("996:988");
    expect(resolveSandboxContainerUser("linux", 996, 988, "rootless")).toBe("0:0");
    expect(resolveSandboxContainerUser("darwin", 501, 20, "rootless")).toBeUndefined();
    expect(resolveSandboxContainerUser("linux", undefined, undefined, "rootful")).toBeUndefined();
  });

  test("resolves the installed Pi dependency root for a read-only sandbox mount", () => {
    const nodeModules = resolvePiNodeModulesDirectory();
    expect(nodeModules.endsWith("/node_modules")).toBe(true);
    expect(Bun.file(join(
      nodeModules,
      "@mariozechner/pi-coding-agent/dist/cli.js",
    )).size).toBeGreaterThan(0);
  });

  test("resolves a provisioned Linux Bun executable for the read-only mount", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shipwright-bun-"));
    const executable = join(directory, "bun");
    try {
      await writeFile(executable, "fixture");
      await chmod(executable, 0o755);
      expect(resolveBunExecutable(executable)).toBe(await realpath(executable));
      expect(() => resolveBunExecutable(join(directory, "missing"))).toThrow(
        "run bun run provision:sandbox-bun",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("requires the Mise-pinned Bun version before sandbox work begins", async () => {
    const miseConfig = await Bun.file(new URL("../../mise.toml", import.meta.url)).text();
    const provisioner = await Bun.file(
      new URL("../../scripts/provision-sandbox-bun.sh", import.meta.url),
    ).text();
    expect(miseConfig).toContain(`bun = "${EXPECTED_SANDBOX_BUN_VERSION}"`);
    expect(provisioner).toContain(`bun_version="${EXPECTED_SANDBOX_BUN_VERSION}"`);
    expect(provisioner).toMatch(/oven\/bun@sha256:[0-9a-f]{64}/);
    expect(requireExpectedBunVersion({
      exitCode: 0,
      stdout: `${EXPECTED_SANDBOX_BUN_VERSION}\n`,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 1,
    })).toBe(EXPECTED_SANDBOX_BUN_VERSION);
    expect(() => requireExpectedBunVersion({
      exitCode: 0,
      stdout: "0.0.0\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 1,
    })).toThrow(`expected ${EXPECTED_SANDBOX_BUN_VERSION}`);
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
