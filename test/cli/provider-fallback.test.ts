import { expect, test } from "bun:test";
import { runWithProviderFallback } from "../../src/cli/dependencies.js";
import type { ProviderConfig } from "../../src/config/provider.js";
import type { AgentExecution } from "../../src/pipeline/receipt.js";

const providers: ProviderConfig[] = [
  { name: "kimi", model: "k3", env: { KIMI_API_KEY: "kimi-key" } },
  { name: "openai-codex", model: "gpt-5.4", env: { OPENAI_API_KEY: "openai-key" } },
];

function execution(): AgentExecution {
  return { runtime: "agentos", software: "pi", provider: "kimi", model: "k3" };
}

test("falls back once when Pi returns a provider quota response", async () => {
  const state = execution();
  const result = await runWithProviderFallback(providers, state, async (provider) => {
    if (provider.name === "kimi") return "403 usage limit for this billing cycle";
    return "done";
  });

  expect(result).toBe("done");
  expect(state).toMatchObject({
    provider: "openai-codex",
    model: "gpt-5.4",
    fallbackUsed: true,
    attempts: [
      { provider: "kimi", model: "k3", outcome: "capacity_failed" },
      { provider: "openai-codex", model: "gpt-5.4", outcome: "succeeded" },
    ],
  });
});

test("does not fall back after an ordinary agent failure", async () => {
  const state = execution();
  const attempted: string[] = [];
  await expect(runWithProviderFallback(providers, state, async (provider) => {
    attempted.push(provider.name);
    throw new Error("agent omitted its outcome artifact");
  })).rejects.toThrow("omitted");
  expect(attempted).toEqual(["kimi"]);
});

test("does not mistake a successful agent discussion of rate limits for provider failure", async () => {
  const state = execution();
  const attempted: string[] = [];
  const result = await runWithProviderFallback(providers, state, async (provider) => {
    attempted.push(provider.name);
    return "Implemented the requested rate limit handling and tests.";
  });

  expect(result).toContain("Implemented");
  expect(attempted).toEqual(["kimi"]);
  expect(state.fallbackUsed).toBe(false);
});

test("reports an exhausted provider chain without leaking provider errors", async () => {
  const state = execution();
  await expect(runWithProviderFallback(providers, state, async () => {
    throw new Error("quota exhausted with secret-shaped upstream detail");
  })).rejects.toThrow("provider fallback capacity exhausted after 2 attempts");
  expect(state.attempts).toHaveLength(2);
});
