import { expect, test } from "bun:test";
import { SandboxWorkspace } from "../../src/sandbox/runtime.js";

const liveTest = process.env.RUN_DOCKER_E2E === "1" ? test : test.skip;

liveTest("runs a command in a disposable Docker sandbox and cleans it up", async () => {
  const workspace = await SandboxWorkspace.start();
  try {
    await workspace.initialize();
    const result = await workspace.run({
      command: "sh",
      args: ["-lc", "printf SANDBOX_OK"],
      cwd: "/home/sandbox/workspace",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("SANDBOX_OK");
  } finally {
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
    const changes = await workspace.inspectChanges();
    expect(changes.changedFiles).toEqual(["source.txt"]);
    expect(changes.patch).toContain("changed");
  } finally {
    await workspace.destroy();
  }
}, 30_000);
