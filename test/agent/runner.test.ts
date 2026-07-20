import { expect, test } from "bun:test";
import { createAndRunPiAgent, runPiAgent, type AgentVm, type AgentOsRuntime } from "../../src/agent/runner.js";

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

  const result = await runPiAgent(vm, { env: {}, name: "openai", model: "gpt-test" }, "fix it");

  expect(result).toBe("done");
  expect(events).toEqual(["mkdir", "settings", "session", "prompt", "close-session", "dispose"]);
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

  await runPiAgent(vm, { env: { KIMI_API_KEY: "test-key" }, name: "kimi", model: "k3" }, "fix it");

  expect(JSON.parse(writes.get("/home/agentos/.pi/agent/settings.json")!)).toEqual({
    defaultProvider: "kimi",
    defaultModel: "k3",
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
    { env: {}, name: "openai", model: "gpt-test" },
    "fix it",
    5_000,
    [{ name: "fix-review-findings", content: "---\nname: fix-review-findings\ndescription: test\n---\n" }],
  );

  const skillPath = "/home/agentos/.pi/agent/skills/fix-review-findings/SKILL.md";
  expect(writes.get(skillPath)).toContain("name: fix-review-findings");
  expect(writes.get("/home/agentos/.pi/agent/extensions/enable-resources.cjs")).toContain("enableResources");
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
    { env: {}, name: "openai", model: "gpt-test" },
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

  await expect(runPiAgent(vm, { env: {}, name: "openai", model: "gpt-test" }, "fix it")).rejects.toThrow("no session");
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
  await expect(runPiAgent(vm, { env: {}, name: "openai", model: "gpt-test" }, "fix it", 5)).rejects.toThrow("timed out");
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
    { env: {}, name: "openai", model: "gpt-test" },
    "fix it",
    5_000,
    [],
    runtime,
  )).resolves.toBe("done");

  expect(events).toEqual(["close-session", "dispose-vm", "dispose-sidecar"]);
});
