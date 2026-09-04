import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAndRunPiAgent,
  PiAgentOutputError,
  runPiAgent,
  runSandboxCodexAgent,
  type AgentVm,
  type AgentOsRuntime,
} from "../../src/agent/runner.js";

test("runPiAgent configures Pi, prompts once, and always cleans up", async () => {
  const events: string[] = [];
  const vm: AgentVm = {
    async mkdir() { events.push("mkdir"); },
    async writeFile() { events.push("settings"); },
    async createSession() { events.push("session"); return { sessionId: "s1" }; },
    async prompt() { events.push("prompt"); return { text: "done" }; },
    closeSession() { events.push("close-session"); },
    async dispose() { events.push("dispose"); },
  };

  const result = await runPiAgent(
    vm,
    { env: {}, name: "openai", model: "gpt-test", thinkingLevel: "low" },
    "fix it",
  );

  expect(result).toBe("done");
  expect(events).toEqual(["mkdir", "settings", "session", "prompt", "close-session", "dispose"]);
});

test("runPiAgent configures the requested Pi thinking level", async () => {
  const writes = new Map<string, string>();
  const vm: AgentVm = {
    async mkdir() {},
    async writeFile(path, content) { writes.set(path, String(content)); },
    async createSession() { return { sessionId: "s1" }; },
    async prompt() { return { text: "done" }; },
    closeSession() {},
    async dispose() {},
  };

  await runPiAgent(
    vm,
    { env: {}, name: "openai", model: "gpt-5.6-luna", thinkingLevel: "xhigh" },
    "fix it",
  );

  expect(JSON.parse(writes.get("/home/agentos/.pi/agent/settings.json")!)).toEqual({
    defaultProvider: "openai",
    defaultModel: "gpt-5.6-luna",
    defaultThinkingLevel: "xhigh",
  });
});

test("runPiAgent projects local Codex OAuth without unrelated auth fields", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shipwright-codex-auth-"));
  const authFile = join(directory, "auth.json");
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const access = `header.${Buffer.from(JSON.stringify({ exp: expires })).toString("base64url")}.signature`;
  writeFileSync(authFile, JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "must-not-be-projected",
      access_token: access,
      refresh_token: "refresh-token",
      account_id: "account-id",
    },
    last_refresh: new Date().toISOString(),
  }), { mode: 0o600 });
  const writes = new Map<string, string>();
  const vm: AgentVm = {
    async mkdir() {},
    async writeFile(path, content) { writes.set(path, String(content)); },
    async createSession() { return { sessionId: "s1" }; },
    async prompt() { return { text: "done" }; },
    closeSession() {},
    async dispose() {},
  };

  try {
    await runPiAgent(vm, {
      authFile,
      env: {},
      name: "openai-codex",
      model: "gpt-5.4",
      thinkingLevel: "low",
    }, "fix it");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  expect(JSON.parse(writes.get("/home/agentos/.pi/agent/auth.json")!)).toEqual({
    "openai-codex": {
      type: "oauth",
      access,
      refresh: "refresh-token",
      expires: expires * 1000,
      accountId: "account-id",
    },
  });
  expect(writes.get("/home/agentos/.pi/agent/auth.json")).not.toContain("must-not-be-projected");
});

test("runPiAgent rejects Codex auth files readable by other users", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shipwright-codex-auth-"));
  const authFile = join(directory, "auth.json");
  writeFileSync(authFile, JSON.stringify({ tokens: {} }));
  // chmod, not writeFileSync's mode option: writeFileSync applies the process
  // umask, so under a restrictive umask (077) the fixture lands at 0600 and
  // silently skips the owner-only branch this test exists to cover.
  chmodSync(authFile, 0o644);
  expect(statSync(authFile).mode & 0o077).not.toBe(0);
  const vm: AgentVm = {
    async mkdir() {},
    async writeFile() {},
    async createSession() { return { sessionId: "s1" }; },
    async prompt() { return { text: "done" }; },
    closeSession() {},
    async dispose() {},
  };

  try {
    await expect(runPiAgent(vm, {
      authFile,
      env: {},
      name: "openai-codex",
      model: "gpt-5.4",
      thinkingLevel: "low",
    }, "fix it")).rejects.toThrow("unreadable, invalid, or not owner-only");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("createAndRunPiAgent routes Codex through the native CLI in the existing disposable workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shipwright-codex-auth-"));
  const authFile = join(directory, "auth.json");
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const access = `header.${Buffer.from(JSON.stringify({ exp: expires })).toString("base64url")}.signature`;
  writeFileSync(authFile, JSON.stringify({
    tokens: {
      id_token: "must-not-be-projected",
      access_token: access,
      refresh_token: "refresh-token",
      account_id: "account-id",
    },
  }), { mode: 0o600 });
  const writes = new Map<string, string>();
  const runs: Array<{ command: string; args?: string[]; env?: Record<string, string> }> = [];
  const success = {
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 12,
  };
  const workspace = {
    client: {
      async writeFsFile({ path }: { path: string }, content: string) {
        writes.set(path, content);
      },
    },
    async runOrThrow(_label: string, request: { command: string; args?: string[] }) {
      runs.push(request);
      return request.command === "cat" ? { ...success, stdout: "done\n" } : success;
    },
    async run(request: { command: string; args?: string[]; env?: Record<string, string> }) {
      runs.push(request);
      return success;
    },
  };

  try {
    await expect(createAndRunPiAgent(
      workspace as never,
      { authFile, env: {}, name: "openai-codex", model: "gpt-5.4", thinkingLevel: "xhigh" },
      "fix it",
      5_000,
      [{ name: "fix-review-findings", content: "skill body" }],
      {
        async createSidecar() { throw new Error("AgentOS must not start for Codex"); },
        async create() { throw new Error("AgentOS must not start for Codex"); },
      },
    )).resolves.toBe("done\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const projected = writes.get("/tmp/shipwright-codex-home/auth.json")!;
  expect(JSON.parse(projected)).toEqual({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "must-not-be-projected",
      access_token: access,
      refresh_token: "refresh-token",
      account_id: "account-id",
    },
  });
  expect(writes.get("/tmp/shipwright-codex-home/skills/fix-review-findings/SKILL.md")).toBe("skill body");
  const prompt = runs.find((run) => run.command === "node")!;
  expect(prompt.args).toContain("/opt/shipwright/node_modules/@openai/codex/bin/codex.js");
  expect(prompt.args).toContain("exec");
  expect(prompt.args).toContain("fix it");
  expect(prompt.args).toContain("model_reasoning_effort=xhigh");
  expect(prompt.args?.at((prompt.args?.indexOf("--model") ?? -2) + 1)).toBe("gpt-5.4");
  expect(prompt.env).toEqual({
    CODEX_HOME: "/tmp/shipwright-codex-home",
  });
  expect(JSON.stringify(prompt)).not.toContain("refresh-token");
  expect(runs.at(-1)).toMatchObject({
    command: "rm",
    args: ["-rf", "--", "/tmp/shipwright-codex-home", "/tmp/shipwright-codex-last-message.txt"],
  });
});

test("runSandboxCodexAgent normalizes Codex CLI failures without leaking stderr", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shipwright-codex-auth-"));
  const authFile = join(directory, "auth.json");
  const access = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  writeFileSync(authFile, JSON.stringify({
    tokens: {
      id_token: "id-token",
      access_token: access,
      refresh_token: "refresh-token",
      account_id: "account-id",
    },
  }), { mode: 0o600 });
  const result = {
    exitCode: 1,
    stdout: "",
    stderr: "401 unauthorized bearer sensitive-upstream-value",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 12,
  };
  const workspace = {
    client: { async writeFsFile() {} },
    async runOrThrow() { return { ...result, exitCode: 0, stderr: "" }; },
    async run(request: { command: string }) {
      return request.command === "node" ? result : { ...result, exitCode: 0, stderr: "" };
    },
  };

  try {
    const run = runSandboxCodexAgent(
      workspace as never,
      { authFile, env: {}, name: "openai-codex", model: "gpt-5.4", thinkingLevel: "low" },
      "fix it",
      5_000,
    );
    await expect(run).rejects.toThrow("OpenAI Codex OAuth authentication failed");
    await expect(run).rejects.not.toThrow("sensitive-upstream-value");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runPiAgent rejects an ACP prompt error instead of accepting empty output", async () => {
  const vm: AgentVm = {
    async mkdir() {},
    async writeFile() {},
    async createSession() { return { sessionId: "s1" }; },
    async prompt() {
      return {
        text: "",
        response: {
          jsonrpc: "2.0" as const,
          id: 1,
          error: { code: -32000, message: "upstream request failed" },
        },
      };
    },
    closeSession() {},
    async dispose() {},
  };

  await expect(
    runPiAgent(vm, { env: {}, name: "openai", model: "gpt-test", thinkingLevel: "low" }, "fix it"),
  ).rejects.toThrow("Pi agent request failed (RPC -32000): upstream request failed");
});

test("runPiAgent retries one empty completed turn in the same session", async () => {
  const prompts: string[] = [];
  const vm: AgentVm = {
    async mkdir() {},
    async writeFile() {},
    async createSession() { return { sessionId: "s1" }; },
    async prompt(_sessionId, prompt) {
      prompts.push(prompt);
      return prompts.length === 1
        ? {
            text: "",
            response: { jsonrpc: "2.0" as const, id: 1, result: { stopReason: "end_turn" } },
          }
        : {
            text: "done",
            response: { jsonrpc: "2.0" as const, id: 2, result: { stopReason: "end_turn" } },
          };
    },
    closeSession() {},
    async dispose() {},
  };

  await expect(
    runPiAgent(vm, { env: {}, name: "openai", model: "gpt-test", thinkingLevel: "low" }, "fix it"),
  ).resolves.toBe("done");
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("previous turn completed without a final response");
});

test("runPiAgent does not recover a canceled empty turn", async () => {
  let prompts = 0;
  const vm: AgentVm = {
    async mkdir() {},
    async writeFile() {},
    async createSession() { return { sessionId: "s1" }; },
    async prompt() {
      prompts += 1;
      return {
        text: "",
        response: { jsonrpc: "2.0" as const, id: 1, result: { stopReason: "cancelled" } },
      };
    },
    closeSession() {},
    async dispose() {},
  };

  await expect(
    runPiAgent(vm, { env: {}, name: "openai", model: "gpt-test", thinkingLevel: "low" }, "fix it"),
  ).rejects.toThrow("without text output (stopReason=cancelled");
  expect(prompts).toBe(1);
});

test("runPiAgent reports safe event diagnostics after two empty turns", async () => {
  let handler: ((event: never) => void) | undefined;
  let prompts = 0;
  let unsubscribed = false;
  const vm = {
    async mkdir() {},
    async writeFile() {},
    async createSession() { return { sessionId: "s1" }; },
    onSessionEvent(_sessionId: string, nextHandler: (event: never) => void) {
      handler = nextHandler;
      return () => { unsubscribed = true; };
    },
    async prompt() {
      prompts += 1;
      handler?.({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_thought_chunk", content: { text: "hidden" } } },
      } as never);
      handler?.({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "tool_call", rawInput: { secret: "ignored" } } },
      } as never);
      if (prompts === 2) {
        handler?.({
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "tool_call_update", status: "failed" } },
        } as never);
      }
      return {
        text: "",
        response: { jsonrpc: "2.0" as const, id: prompts, result: { stopReason: "end_turn" } },
      };
    },
    closeSession() {},
    async dispose() {},
  } as AgentVm;

  const run = runPiAgent(
    vm,
    { env: {}, name: "openai", model: "gpt-test", thinkingLevel: "low" },
    "fix it",
  );
  await expect(run).rejects.toBeInstanceOf(PiAgentOutputError);
  await expect(run).rejects.toThrow(
    "stopReason=end_turn; agentMessageChunks=0, agentThoughtChunks=2, toolCalls=2, toolFailures=1",
  );
  expect(unsubscribed).toBe(true);
});

test("runPiAgent configures Pi's Kimi K3 catalog", async () => {
  const writes = new Map<string, string>();
  const vm: AgentVm = {
    async mkdir() {},
    async writeFile(path, content) { writes.set(path, String(content)); },
    async createSession() { return { sessionId: "s1" }; },
    async prompt() { return { text: "done" }; },
    closeSession() {},
    async dispose() {},
  };

  await runPiAgent(
    vm,
    { env: { KIMI_API_KEY: "test-key" }, name: "kimi", model: "k3", thinkingLevel: "low" },
    "fix it",
  );

  expect(JSON.parse(writes.get("/home/agentos/.pi/agent/settings.json")!)).toEqual({
    defaultProvider: "kimi",
    defaultModel: "k3",
    defaultThinkingLevel: "low",
  });
  expect(JSON.parse(writes.get("/home/agentos/.pi/agent/models.json")!)).toEqual({
    providers: {
      kimi: {
        api: "anthropic-messages",
        apiKey: "KIMI_API_KEY",
        authHeader: true,
        baseUrl: "https://api.kimi.com/coding",
        models: [
          {
            contextWindow: 1048576,
            id: "k3",
            input: ["text", "image"],
            maxTokens: 32768,
            reasoning: true,
            compat: {
              supportsDeveloperRole: false,
            },
          },
        ],
      },
    },
  });
});

test("runPiAgent projects a canonical skill before creating the session", async () => {
  const events: string[] = [];
  const writes = new Map<string, string>();
  const vm: AgentVm = {
    async mkdir(path) { events.push(`mkdir:${path}`); },
    async writeFile(path, content) { writes.set(path, String(content)); events.push(`write:${path}`); },
    async createSession() { events.push("session"); return { sessionId: "s1" }; },
    async prompt() { return { text: "done" }; },
    closeSession() {},
    async dispose() {},
  };

  await runPiAgent(
    vm,
    { env: {}, name: "openai", model: "gpt-test", thinkingLevel: "low" },
    "fix it",
    5_000,
    [{ name: "fix-review-findings", content: "---\nname: fix-review-findings\ndescription: test\n---\n" }],
  );

  const skillPath = "/home/agentos/.pi/agent/skills/fix-review-findings/SKILL.md";
  expect(writes.get(skillPath)).toContain("name: fix-review-findings");
  expect(writes.get("/home/agentos/.pi/agent/extensions/enable-resources.ts")).toContain("enableResources");
  expect(events.indexOf(`write:${skillPath}`)).toBeLessThan(events.indexOf("session"));
});

test("runPiAgent rejects unsafe skill names", async () => {
  const vm: AgentVm = {
    async mkdir() {},
    async writeFile() {},
    async createSession() { return { sessionId: "s1" }; },
    async prompt() { return { text: "done" }; },
    closeSession() {},
    async dispose() {},
  };
  await expect(runPiAgent(
    vm,
    { env: {}, name: "openai", model: "gpt-test", thinkingLevel: "low" },
    "fix it",
    5_000,
    [{ name: "../bad", content: "bad" }],
  )).rejects.toThrow("invalid skill name");
});

test("runPiAgent disposes the VM when session creation fails", async () => {
  const events: string[] = [];
  const vm: AgentVm = {
    async mkdir() {},
    async writeFile() {},
    async createSession() { throw new Error("no session"); },
    async prompt() { return { text: "unreachable" }; },
    closeSession() { events.push("close-session"); },
    async dispose() { events.push("dispose"); },
  };

  await expect(runPiAgent(
    vm,
    { env: {}, name: "openai", model: "gpt-test", thinkingLevel: "low" },
    "fix it",
  )).rejects.toThrow("no session");
  expect(events).toEqual(["dispose"]);
});

test("runPiAgent bounds the prompt and still tears down", async () => {
  const events: string[] = [];
  const vm: AgentVm = {
    async mkdir() {},
    async writeFile() {},
    async createSession() { return { sessionId: "s1" }; },
    async prompt() { return new Promise(() => undefined); },
    closeSession() { events.push("close-session"); },
    async dispose() { events.push("dispose"); },
  };
  await expect(runPiAgent(
    vm,
    { env: {}, name: "openai", model: "gpt-test", thinkingLevel: "low" },
    "fix it",
    5,
  )).rejects.toThrow("timed out");
  expect(events).toEqual(["close-session", "dispose"]);
});

test("createAndRunPiAgent gives its explicit sidecar a deadline beyond the Pi deadline", async () => {
  const events: string[] = [];
  const vm: AgentVm = {
    async mkdir() {},
    async writeFile() {},
    async createSession() { return { sessionId: "s1" }; },
    async prompt() { return { text: "done" }; },
    closeSession() { events.push("close-session"); },
    async dispose() { events.push("dispose-vm"); },
  };
  const sidecar = {
    async dispose() { events.push("dispose-sidecar"); },
  } as never;
  const runtime: AgentOsRuntime = {
    async createSidecar(options) {
      expect(options).toEqual({ frameTimeoutMs: 65_000 });
      return sidecar;
    },
    async create(options) {
      expect(options?.sidecar).toEqual({ kind: "explicit", handle: sidecar });
      expect(options?.defaultSoftware).toBe(false);
      const packagePaths = (options?.software ?? [])
        .flatMap((software) => Array.isArray(software) ? software : [software])
        .map((software) => (software as { packagePath: string }).packagePath);
      expect(packagePaths).toHaveLength(9);
      expect(new Set(packagePaths).size).toBe(packagePaths.length);
      expect(packagePaths.every((packagePath) => statSync(packagePath).isFile())).toBe(true);
      expect(options?.limits?.jsRuntime).toEqual({
        cpuTimeLimitMs: 65_000,
        wallClockLimitMs: 65_000,
      });
      return vm;
    },
  };
  const workspace = {
    createMount() { return {}; },
    createToolkit() { return {}; },
  };

  await expect(createAndRunPiAgent(
    workspace as never,
    { env: {}, name: "openai", model: "gpt-test", thinkingLevel: "low" },
    "fix it",
    5_000,
    [],
    runtime,
  )).resolves.toBe("done");

  expect(events).toEqual(["close-session", "dispose-vm", "dispose-sidecar"]);
});
