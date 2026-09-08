import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProcessRunRequest } from "sandbox-agent";
import { SandboxWorkspace } from "../../src/sandbox/runtime.js";

const exec = promisify(execFile);
const liveTest = process.env.RUN_DOCKER_E2E === "1" ? test : test.skip;
async function fixture(action: (workspace: SandboxWorkspace, directory: string, base: string, calls: () => number) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "shipwright-replay-test-"));
  const git = (...args: string[]) => exec("git", args, { cwd: directory, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  let stopped = false;
  let processCalls = 0;
  const workspace: SandboxWorkspace = Object.assign(Object.create(SandboxWorkspace.prototype), {
    hostWorkspace: directory,
    sandboxStopped: false,
    client: {
      destroySandbox: async () => { stopped = true; },
      runProcess: async (request: ProcessRunRequest) => {
        processCalls++;
        if (stopped) throw new Error("sandbox is stopped");
        const result = await exec(request.command, request.args ?? [], { cwd: directory });
        return { ...result, exitCode: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false };
      },
    },
  });
  try {
    await git("init", "-q");
    await writeFile(join(directory, "content.bin"), new Uint8Array([0, 1, 2, 255]));
    await git("add", "content.bin");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await workspace.captureAuthorizedRepoConfig();
    await action(workspace, directory, base, () => processCalls);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("retained binary candidate replays after sandbox quiescence with the same tree", async () => {
  await fixture(async (workspace, directory, base, calls) => {
    const binary = new Uint8Array([0, 9, 255, 128, 0, 42]);
    await writeFile(join(directory, "content.bin"), binary);
    const retained = await workspace.inspectChanges(base);
    expect(retained.patch).toContain("GIT binary patch");
    await workspace.quiesce();
    await workspace.resetToReviewBase(base, "review-follow-up");
    await workspace.applyReviewCandidatePatch(retained.patchData!);
    expect(new Uint8Array(await readFile(join(directory, "content.bin")))).toEqual(binary);
    expect((await workspace.inspectChanges(base)).resultingTreeSha).toBe(retained.resultingTreeSha);
    expect(calls()).toBe(0);
    expect((await readdir(directory)).some((name) => name.startsWith(".shipwright-review-patch-"))).toBe(false);
  });
});

test("an empty retained candidate replays as an unchanged tree", async () => {
  await fixture(async (workspace, _directory, base, calls) => {
    const retained = await workspace.inspectChanges(base);
    expect(retained.patchBytes).toBe(0);
    await workspace.applyReviewCandidatePatch(retained.patchData!);
    await workspace.quiesce();
    await workspace.resetToReviewBase(base, "review-follow-up");
    await workspace.applyReviewCandidatePatch(retained.patchData!);
    expect((await workspace.inspectChanges(base)).resultingTreeSha).toBe(retained.resultingTreeSha);
    expect(calls()).toBe(0);
  });
});

test("retained replay rejects changed repository configuration", async () => {
  await fixture(async (workspace, directory) => {
    await exec("git", ["config", "core.fsmonitor", "untrusted-monitor"], { cwd: directory });
    await workspace.quiesce();
    await expect(workspace.applyReviewCandidatePatch(new Uint8Array())).rejects.toThrow("repository Git configuration changed after authorization");
  });
});

liveTest("verification plan accepts a no-code candidate and executes both worktrees", async () => {
  await fixture(async (workspace, _directory, base) => {
    await workspace.quiesce();
    const result = await workspace.verifyReviewPlan({
      baselineSha: base,
      patch: new Uint8Array(),
      command: "git rev-parse HEAD^{tree}",
      timeoutMs: 5000,
    });
    expect(result.baseline.exitCode).toBe(0);
    expect(result.candidate.exitCode).toBe(0);
    expect(result.candidate.stdout).toBe(result.baseline.stdout);
    expect(result.candidate.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});

test("retained text diff preserves non-UTF8 bytes without NUL", async () => {
  await fixture(async (workspace, directory, base) => {
    const bytes = new Uint8Array([255, 10]);
    await writeFile(join(directory, "non-utf8.txt"), bytes);
    const retained = await workspace.inspectChanges(base);
    await workspace.quiesce();
    await workspace.resetToReviewBase(base, "review-follow-up");
    await rm(join(directory, "non-utf8.txt"));
    await workspace.applyReviewCandidatePatch(retained.patchData!);
    expect(new Uint8Array(await readFile(join(directory, "non-utf8.txt")))).toEqual(bytes);
    expect((await workspace.inspectChanges(base)).resultingTreeSha).toBe(retained.resultingTreeSha);
  });
});
