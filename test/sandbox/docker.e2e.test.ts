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
