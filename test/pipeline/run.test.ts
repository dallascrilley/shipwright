import { expect, test } from "bun:test";
import { PI_AGENT_OUTPUT_ERROR_CODE, PiAgentOutputError } from "../../src/agent/runner.js";
import { runShipwright, type PipelineDependencies, type WorkspacePort } from "../../src/pipeline/run.js";
import type { AuthorizedIssue } from "../../src/github/app-client.js";

function fixture(options: {
  agentError?: string;
  verifyExit?: number;
  protectedFile?: boolean;
  publish?: boolean;
  verifyStdout?: string;
  verifyStderr?: string;
  secretPatch?: boolean;
} = {}) {
  const events: string[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const workspace: WorkspacePort = {
    async clone() { events.push("clone"); },
    async prepareForAgent() { events.push("prepare"); },
    async verify() {
      events.push("verify");
      return {
        exitCode: options.verifyExit ?? 0,
        stdout: options.verifyStdout,
        stderr: options.verifyStderr,
      };
    },
    async inspectChanges() {
      events.push("inspect");
      const patch = options.secretPatch
        ? "const token = \"ghs_123456789012345678901234567890123456\";"
        : "diff";
      return {
        changedFiles: [options.protectedFile ? ".github/workflows/x.yml" : "src/a.ts"],
        patch,
        patchBytes: patch.length,
      };
    },
    async quiesce() { events.push("quiesce"); },
    async assertRunIdentity() { events.push("identity"); },
    async commit() { events.push("commit"); return "commit1"; },
    async push() { events.push("push"); },
    async destroy() { events.push("destroy"); },
  };
  const authorized: AuthorizedIssue = {
    issue: { owner: "acme", repo: "widget", number: 2, url: "https://github.com/acme/widget/issues/2", title: "Fix", body: "body", defaultBranch: "main", baseSha: "base1", installationId: 3 },
    repositoryClient: {
      async getRepository() { throw new Error("unused"); },
      async getIssue() { throw new Error("unused"); },
      async getBranchSha() { throw new Error("unused"); },
      async listPullRequests() { return []; },
      async createPullRequest() { return { number: 1, url: "https://example/pr/1" }; },
    },
    async withInstallationToken(action) { return action("secret"); },
  };
  const deps: PipelineDependencies = {
    execution: { runtime: "agentos", software: "pi", provider: "kimi", model: "kimi-for-coding" },
    async authorize() { events.push("authorize"); return authorized; },
    async createWorkspace() { events.push("workspace"); return workspace; },
    async runAgent() {
      events.push("agent");
      if (options.agentError) throw new Error(options.agentError);
      return "done";
    },
    async openPullRequest() { events.push("pr"); return { number: 5, url: "https://example/pr/5" }; },
    async writeReceipt(_path, receipt) {
      events.push(`receipt:${receipt.phase}`);
      receipts.push(structuredClone(receipt) as unknown as Record<string, unknown>);
    },
  };
  return { deps, events, receipts };
}

test("capacity-exhausted provider chain is classified distinctly", async () => {
  const { deps, events, receipts } = fixture({
    agentError: "provider fallback capacity exhausted after 2 attempts",
  });

  await expect(runShipwright({
    issueUrl: "https://github.com/acme/widget/issues/2",
    verifyCommand: "bun test",
    publish: false,
    timeoutMinutes: 2,
  }, deps)).rejects.toThrow("provider fallback capacity exhausted");

  expect(events).not.toContain("verify");
  expect(receipts.at(-1)?.errorCode).toBe("provider_quota_exhausted");
});

test("empty Pi turns are classified distinctly", async () => {
  const { deps, events, receipts } = fixture();
  deps.runAgent = async () => {
    throw new PiAgentOutputError(
      "Pi agent completed twice without text output (stopReason=end_turn; toolCalls=0)",
    );
  };

  await expect(runShipwright({
    issueUrl: "https://github.com/acme/widget/issues/2",
    verifyCommand: "bun test",
    publish: false,
    timeoutMinutes: 2,
  }, deps)).rejects.toThrow("completed twice without text output");

  expect(events).not.toContain("verify");
  expect(receipts.at(-1)?.errorCode).toBe(PI_AGENT_OUTPUT_ERROR_CODE);
});

test("dry run verifies and applies policy without publishing", async () => {
  const { deps, events } = fixture();
  const receipt = await runShipwright({ issueUrl: "https://github.com/acme/widget/issues/2", verifyCommand: "bun test", publish: false, timeoutMinutes: 2 }, deps);
  expect(receipt.phase).toBe("complete");
  expect(receipt.execution).toEqual({
    runtime: "agentos",
    software: "pi",
    provider: "kimi",
    model: "kimi-for-coding",
  });
  expect(receipt.commitSha).toBeUndefined();
  expect(receipt.errorMessage).toBeUndefined();
  expect(events).not.toContain("push");
  expect(events.at(-1)).toBe("destroy");
});

test("emits cloned progress snapshots in pipeline order", async () => {
  const { deps } = fixture();
  const snapshots: Array<{ phase: string; changedFiles: string[]; execution: unknown }> = [];
  deps.onProgress = (receipt) => {
    snapshots.push({ phase: receipt.phase, changedFiles: receipt.changedFiles, execution: receipt.execution });
  };

  const receipt = await runShipwright({ issueUrl: "https://github.com/acme/widget/issues/2", verifyCommand: "bun test", publish: false, timeoutMinutes: 2 }, deps);

  expect(snapshots.map((snapshot) => snapshot.phase)).toEqual([
    "intake",
    "workspace",
    "agent",
    "verify",
    "verify",
    "policy",
    "policy",
    "complete",
  ]);
  expect(snapshots.at(-2)?.changedFiles).toEqual(["src/a.ts"]);
  expect(snapshots[0]?.changedFiles).toEqual([]);
  expect(snapshots[0]?.changedFiles).not.toBe(receipt.changedFiles);
  expect(snapshots[0]?.execution).toEqual(receipt.execution);
  expect(snapshots[0]?.execution).not.toBe(receipt.execution);
});

test("failed independent verification blocks policy and publication", async () => {
  const { deps, events, receipts } = fixture({
    verifyExit: 1,
    verifyStderr: "AssertionError: expected true",
    verifyStdout: "1 fail",
  });
  await expect(runShipwright({ issueUrl: "https://github.com/acme/widget/issues/2", verifyCommand: "false", publish: true, timeoutMinutes: 2 }, deps)).rejects.toThrow("verification failed");
  expect(events).not.toContain("inspect");
  expect(events).not.toContain("push");
  expect(events).toContain("receipt:verify");
  expect(events.at(-1)).toBe("destroy");
  const failed = receipts.at(-1) as {
    errorCode?: string;
    errorMessage?: string;
    verification: { stderrTail?: string; stdoutTail?: string };
  };
  expect(failed.errorCode).toBe("verification_failed");
  expect(failed.errorMessage).toBe("independent verification failed");
  expect(failed.verification.stderrTail).toBe("AssertionError: expected true");
  expect(failed.verification.stdoutTail).toBe("1 fail");
});

test("protected changes block publication", async () => {
  const { deps, events, receipts } = fixture({ protectedFile: true });
  await expect(runShipwright({ issueUrl: "https://github.com/acme/widget/issues/2", verifyCommand: "bun test", publish: true, timeoutMinutes: 2 }, deps)).rejects.toThrow("protected");
  expect(events).not.toContain("commit");
  expect(events).toContain("receipt:policy");
  const failed = receipts.at(-1) as { errorCode?: string; errorMessage?: string };
  expect(failed.errorCode).toBe("policy_failed");
  expect(failed.errorMessage).toContain("protected path");
});

test("secret-looking patch content blocks publication", async () => {
  const { deps, events, receipts } = fixture({ secretPatch: true });
  await expect(runShipwright({ issueUrl: "https://github.com/acme/widget/issues/2", verifyCommand: "bun test", publish: true, timeoutMinutes: 2 }, deps)).rejects.toThrow("secret");
  expect(events).not.toContain("commit");
  expect(events).toContain("receipt:policy");
  const failed = receipts.at(-1) as { errorMessage?: string };
  expect(failed.errorMessage).toContain("patch appears to contain a secret");
});

test("publish commits, pushes, then opens the PR", async () => {
  const { deps, events } = fixture({ publish: true });
  const receipt = await runShipwright({ issueUrl: "https://github.com/acme/widget/issues/2", verifyCommand: "bun test", publish: true, timeoutMinutes: 2 }, deps);
  expect(receipt.pullRequestUrl).toEndWith("/5");
  expect(events.indexOf("identity")).toBeLessThan(events.indexOf("commit"));
  expect(events.indexOf("quiesce")).toBeLessThan(events.indexOf("identity"));
  expect(events.indexOf("commit")).toBeLessThan(events.indexOf("push"));
  expect(events.indexOf("push")).toBeLessThan(events.indexOf("pr"));
});

test("malformed issue input still writes an intake failure receipt", async () => {
  const { deps, events } = fixture();
  await expect(runShipwright({ issueUrl: "not-a-url", verifyCommand: "bun test", publish: false, timeoutMinutes: 2 }, deps)).rejects.toThrow("canonical");
  expect(events).toEqual(["receipt:intake"]);
});

test("an abort during agent work writes a receipt and destroys the workspace", async () => {
  const { deps, events } = fixture();
  const controller = new AbortController();
  deps.signal = controller.signal;
  deps.runAgent = async () => new Promise(() => undefined);
  setTimeout(() => controller.abort(new Error("stop")), 5);

  await expect(runShipwright({ issueUrl: "https://github.com/acme/widget/issues/2", verifyCommand: "bun test", publish: false, timeoutMinutes: 2 }, deps)).rejects.toThrow("stop");
  expect(events).toContain("receipt:agent");
  expect(events.at(-1)).toBe("destroy");
});

test("abort after successful verification blocks policy and publication", async () => {
  const { deps, events } = fixture({ publish: true });
  const controller = new AbortController();
  deps.signal = controller.signal;
  deps.onProgress = (receipt) => {
    if (receipt.phase === "verify" && receipt.verification.passed) {
      controller.abort(new Error("stop after verify"));
    }
  };

  await expect(runShipwright({ issueUrl: "https://github.com/acme/widget/issues/2", verifyCommand: "bun test", publish: true, timeoutMinutes: 2 }, deps)).rejects.toThrow("stop after verify");
  expect(events).not.toContain("inspect");
  expect(events).not.toContain("commit");
  expect(events).not.toContain("push");
  expect(events).not.toContain("pr");
  expect(events).toContain("receipt:verify");
  expect(events.at(-1)).toBe("destroy");
});

test("redacts secrets in verification tails before progress emission", async () => {
  const token = "ghs_" + "1".repeat(36);
  const { deps } = fixture({
    verifyExit: 1,
    verifyStderr: `failed with ${token}`,
  });
  const snapshots: Array<{ stderrTail?: string }> = [];
  deps.onProgress = (receipt) => {
    if (receipt.verification.stderrTail) {
      snapshots.push({ stderrTail: receipt.verification.stderrTail });
    }
  };

  await expect(
    runShipwright(
      {
        issueUrl: "https://github.com/acme/widget/issues/2",
        verifyCommand: "false",
        publish: false,
        timeoutMinutes: 2,
      },
      deps,
    ),
  ).rejects.toThrow("verification failed");

  expect(snapshots.length).toBeGreaterThan(0);
  for (const snapshot of snapshots) {
    expect(snapshot.stderrTail).not.toContain(token);
    expect(snapshot.stderrTail).toContain("[REDACTED]");
  }
});

test("abort after publish phase starts blocks push and PR creation", async () => {
  const { deps, events } = fixture({ publish: true });
  const controller = new AbortController();
  deps.signal = controller.signal;
  deps.onProgress = (receipt) => {
    if (receipt.phase === "publish") {
      controller.abort(new Error("stop during publish"));
    }
  };

  await expect(
    runShipwright(
      {
        issueUrl: "https://github.com/acme/widget/issues/2",
        verifyCommand: "bun test",
        publish: true,
        timeoutMinutes: 2,
      },
      deps,
    ),
  ).rejects.toThrow("stop during publish");
  expect(events).not.toContain("commit");
  expect(events).not.toContain("push");
  expect(events).not.toContain("pr");
  expect(events).toContain("receipt:publish");
  expect(events.at(-1)).toBe("destroy");
});
