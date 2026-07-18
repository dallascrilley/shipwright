import { expect, test } from "bun:test";
import { runPiAgent, type AgentVm } from "../../src/agent/runner.js";

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
