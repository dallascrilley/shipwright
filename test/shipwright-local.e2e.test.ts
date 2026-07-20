import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAndRunPiAgent } from "../src/agent/runner.js";
import { buildProgrammingPrompt } from "../src/agent/prompt.js";
import { resolveProvider } from "../src/config/provider.js";
import { SandboxWorkspace } from "../src/sandbox/runtime.js";

const liveTest = process.env.RUN_LOCAL_PI_E2E === "1" ? test : test.skip;
const fixtureRoot = fileURLToPath(new URL("fixtures/issue-repo/", import.meta.url));

liveTest("Pi fixes a failing local repository and host verification passes", async () => {
  const workspace = await SandboxWorkspace.start();
  try {
    await workspace.initialize();
    for (const path of ["package.json", "src/math.ts", "test/math.fixture.ts"]) {
      await workspace.client.writeFsFile(
        { path: `/home/sandbox/workspace/${path}` },
        await readFile(`${fixtureRoot}${path}`, "utf8"),
      );
    }
    await workspace.prepareForAgent();

    const before = await workspace.verify("npm test", 60_000);
    expect(before.exitCode).not.toBe(0);

    const response = await createAndRunPiAgent(
      workspace,
      resolveProvider(),
      buildProgrammingPrompt({
        issueUrl: "https://github.com/example/fixture/issues/1",
        title: "Correct the add function",
        body: "The add function subtracts. Make the existing test pass with the smallest source change.",
        verifyCommand: "npm test",
      }),
    );

    const after = await workspace.verify("npm test", 60_000);
    const source = await workspace.client.readFsFile({ path: "/home/sandbox/workspace/src/math.ts" });
    const decodedSource = new TextDecoder().decode(source);
    if (after.exitCode !== 0) {
      throw new Error(`Pi did not repair the fixture.\nResponse: ${response}\nstdout:\n${after.stdout}\nstderr:\n${after.stderr}\nsource:\n${decodedSource}`);
    }
    expect(decodedSource).toContain("left + right");
  } finally {
    await workspace.destroy();
  }
}, 300_000);
