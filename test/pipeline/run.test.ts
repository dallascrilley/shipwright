import { expect, test } from "bun:test";
import { runProgrammingAgent, type PipelineDependencies, type WorkspacePort } from "../../src/pipeline/run.js";
import type { AuthorizedIssue } from "../../src/github/app-client.js";

function fixture(options: { verifyExit?: number; protectedFile?: boolean; publish?: boolean } = {}) {
  const events: string[] = [];
  const workspace: WorkspacePort = {
    async clone() { events.push("clone"); },
    async prepareForAgent() { events.push("prepare"); },
    async verify() { events.push("verify"); return { exitCode: options.verifyExit ?? 0 }; },
    async inspectChanges() { events.push("inspect"); return { changedFiles: [options.protectedFile ? ".github/workflows/x.yml" : "src/a.ts"], patch: "diff", patchBytes: 4 }; },
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
    async runAgent() { events.push("agent"); return "done"; },
    async openPullRequest() { events.push("pr"); return { number: 5, url: "https://example/pr/5" }; },
    async writeReceipt(_path, receipt) { events.push(`receipt:${receipt.phase}`); },
  };
  return { deps, events };
}

test("dry run verifies and applies policy without publishing", async () => {
  const { deps, events } = fixture();
  const receipt = await runProgrammingAgent({ issueUrl: "https://github.com/acme/widget/issues/2", verifyCommand: "bun test", publish: false, timeoutMinutes: 2 }, deps);
  expect(receipt.phase).toBe("complete");
  expect(receipt.execution).toEqual({
    runtime: "agentos",
    software: "pi",
    provider: "kimi",
    model: "kimi-for-coding",
  });
  expect(receipt.commitSha).toBeUndefined();
  expect(events).not.toContain("push");
  expect(events.at(-1)).toBe("destroy");
});

test("emits cloned progress snapshots in pipeline order", async () => {
  const { deps } = fixture();
  const snapshots: Array<{ phase: string; changedFiles: string[]; execution: unknown }> = [];
  deps.onProgress = (receipt) => {
    snapshots.push({ phase: receipt.phase, changedFiles: receipt.changedFiles, execution: receipt.execution });
  };

  const receipt = await runProgrammingAgent({ issueUrl: "https://github.com/acme/widget/issues/2", verifyCommand: "bun test", publish: false, timeoutMinutes: 2 }, deps);

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
  const { deps, events } = fixture({ verifyExit: 1 });
  await expect(runProgrammingAgent({ issueUrl: "https://github.com/acme/widget/issues/2", verifyCommand: "false", publish: true, timeoutMinutes: 2 }, deps)).rejects.toThrow("verification failed");
  expect(events).not.toContain("inspect");
  expect(events).not.toContain("push");
  expect(events).toContain("receipt:verify");
  expect(events.at(-1)).toBe("destroy");
});

test("protected changes block publication", async () => {
  const { deps, events } = fixture({ protectedFile: true });
  await expect(runProgrammingAgent({ issueUrl: "https://github.com/acme/widget/issues/2", verifyCommand: "bun test", publish: true, timeoutMinutes: 2 }, deps)).rejects.toThrow("protected");
  expect(events).not.toContain("commit");
  expect(events).toContain("receipt:policy");
});

test("publish commits, pushes, then opens the PR", async () => {
  const { deps, events } = fixture({ publish: true });
  const receipt = await runProgrammingAgent({ issueUrl: "https://github.com/acme/widget/issues/2", verifyCommand: "bun test", publish: true, timeoutMinutes: 2 }, deps);
  expect(receipt.pullRequestUrl).toEndWith("/5");
  expect(events.indexOf("identity")).toBeLessThan(events.indexOf("commit"));
  expect(events.indexOf("commit")).toBeLessThan(events.indexOf("push"));
  expect(events.indexOf("push")).toBeLessThan(events.indexOf("pr"));
});

test("malformed issue input still writes an intake failure receipt", async () => {
  const { deps, events } = fixture();
  await expect(runProgrammingAgent({ issueUrl: "not-a-url", verifyCommand: "bun test", publish: false, timeoutMinutes: 2 }, deps)).rejects.toThrow("canonical");
  expect(events).toEqual(["receipt:intake"]);
});

test("an abort during agent work writes a receipt and destroys the workspace", async () => {
  const { deps, events } = fixture();
  const controller = new AbortController();
  deps.signal = controller.signal;
  deps.runAgent = async () => new Promise(() => undefined);
  setTimeout(() => controller.abort(new Error("stop")), 5);

  await expect(runProgrammingAgent({ issueUrl: "https://github.com/acme/widget/issues/2", verifyCommand: "bun test", publish: false, timeoutMinutes: 2 }, deps)).rejects.toThrow("stop");
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

  await expect(runProgrammingAgent({ issueUrl: "https://github.com/acme/widget/issues/2", verifyCommand: "bun test", publish: true, timeoutMinutes: 2 }, deps)).rejects.toThrow("stop after verify");
  expect(events).not.toContain("inspect");
  expect(events).not.toContain("commit");
  expect(events).not.toContain("push");
  expect(events).not.toContain("pr");
  expect(events).toContain("receipt:verify");
  expect(events.at(-1)).toBe("destroy");
});
