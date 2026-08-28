import { expect, test } from "bun:test";
import {
  EXPECTED_SANDBOX_BUN_VERSION,
  SandboxWorkspace,
} from "../../src/sandbox/runtime.js";

const liveTest = process.env.RUN_DOCKER_E2E === "1" ? test : test.skip;

liveTest("runs a command in a disposable Docker sandbox and cleans it up", async () => {
  const workspace = await SandboxWorkspace.start();
  try {
    await workspace.initialize();
    const result = await workspace.run({
      command: "sh",
      args: ["-lc", "printf SANDBOX_OK > write-probe && cat write-probe"],
      cwd: "/home/sandbox/workspace",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("SANDBOX_OK");
  } finally {
    await workspace.destroy();
  }
}, 30_000);

liveTest("exposes the pinned Bun runtime inside the disposable sandbox", async () => {
  const workspace = await SandboxWorkspace.start();
  try {
    await workspace.initialize();
    const result = await workspace.run({ command: "bun", args: ["--version"] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(EXPECTED_SANDBOX_BUN_VERSION);
  } finally {
    await workspace.destroy();
  }
}, 30_000);

liveTest("rejects a nonempty sandbox workspace", async () => {
  const workspace = await SandboxWorkspace.start();
  try {
    await workspace.runOrThrow("nonempty workspace fixture", {
      command: "touch",
      args: ["existing-file"],
      cwd: "/home/sandbox/workspace",
    });
    await expect(workspace.initialize()).rejects.toThrow("workspace initialization failed");
  } finally {
    await workspace.destroy();
  }
}, 30_000);

liveTest("rejects an inaccessible sandbox workspace", async () => {
  const workspace = await SandboxWorkspace.start();
  try {
    await workspace.runOrThrow("inaccessible workspace fixture", {
      command: "chmod",
      args: ["000", "/home/sandbox/workspace"],
      cwd: "/",
    });
    await expect(workspace.initialize()).rejects.toThrow("workspace initialization failed");
  } finally {
    await workspace.run({
      command: "chmod",
      args: ["700", "/home/sandbox/workspace"],
      cwd: "/",
    });
    await workspace.destroy();
  }
}, 30_000);

liveTest("removes the reserved outcome artifact and inspects staged changes", async () => {
  const workspace = await SandboxWorkspace.start();
  try {
    await workspace.initialize();
    await workspace.runOrThrow("fixture repository", {
      command: "sh",
      args: ["-lc", [
        "git init -q",
        "git config user.name Test",
        "git config user.email test@example.com",
        "printf 'base\\n' > source.txt",
        "git add source.txt",
        "git commit -qm base",
      ].join(" && ")],
      cwd: "/home/sandbox/workspace",
    });
    const authorizedHead = (await workspace.runOrThrow("fixture head", {
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: "/home/sandbox/workspace",
    })).stdout.trim();
    await workspace.prepareReviewArtifact(".agentos-review-resolution.json");
    await workspace.runOrThrow("staged fixture changes", {
      command: "sh",
      args: ["-lc", [
        "printf '{\"threads\":[]}' > .agentos-review-resolution.json",
        "git add .agentos-review-resolution.json",
        "printf 'changed\\n' > source.txt",
        "git add source.txt",
      ].join(" && ")],
      cwd: "/home/sandbox/workspace",
    });
    expect(await workspace.readAndRemoveArtifact(".agentos-review-resolution.json")).toContain("threads");
    const changes = await workspace.inspectChanges(authorizedHead);
    expect(changes.changedFiles).toEqual(["source.txt"]);
    expect(changes.patch).toContain("changed");

    // A commit by the agent must not hide the change: host git diffs against
    // the authorized head, not the moved sandbox HEAD.
    await workspace.runOrThrow("agent commit that would move HEAD", {
      command: "sh",
      args: ["-c", "git commit -qm agent-move"],
      cwd: "/home/sandbox/workspace",
    });
    const afterCommit = await workspace.inspectChanges(authorizedHead);
    expect(afterCommit.changedFiles).toEqual(["source.txt"]);
  } finally {
    await workspace.destroy();
  }
}, 30_000);
