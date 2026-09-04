import { describe, expect, test } from "bun:test";
import { piSettingsConfig, resolveProvider, resolveProviderChain } from "../../src/config/provider.js";

describe("resolveProvider", () => {
  test("serializes the provider, model, and thinking level for Pi clients", () => {
    expect(JSON.parse(piSettingsConfig({
      env: {},
      name: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "xhigh",
    }))).toEqual({
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-luna",
      defaultThinkingLevel: "xhigh",
    });
  });

  test("selects an explicitly requested configured provider", () => {
    expect(
      resolveProvider({ AGENTOS_PROVIDER: "openai", OPENAI_API_KEY: "test-key" }),
    ).toMatchObject({ name: "openai", model: "gpt-4.1-mini" });
  });

  test("supports an explicit model override", () => {
    expect(resolveProvider({ OPENAI_API_KEY: "key", AGENTOS_MODEL: "gpt-custom" }).model).toBe("gpt-custom");
  });

  test("uses a validated Pi thinking level", () => {
    expect(resolveProvider({
      AGENTOS_PROVIDER: "openai-codex",
      AGENTOS_CODEX_AUTH_FILE: "/secure/codex-auth.json",
      AGENTOS_MODEL: "gpt-5.6-luna",
      AGENTOS_THINKING_LEVEL: "xhigh",
    })).toMatchObject({ thinkingLevel: "xhigh" });

    expect(() => resolveProvider({
      AGENTOS_PROVIDER: "openai-codex",
      AGENTOS_CODEX_AUTH_FILE: "/secure/codex-auth.json",
      AGENTOS_THINKING_LEVEL: "maximum",
    })).toThrow("AGENTOS_THINKING_LEVEL");
  });

  test("defaults subscription OAuth to Luna", () => {
    expect(resolveProvider({
      AGENTOS_PROVIDER: "openai-codex",
      AGENTOS_CODEX_AUTH_FILE: "/secure/codex-auth.json",
    })).toMatchObject({ model: "gpt-5.6-luna" });
  });

  test("selects the Kimi Coding model through the Kimi provider", () => {
    expect(
      resolveProvider({ AGENTOS_PROVIDER: "kimi", KIMI_API_KEY: "test-key" }),
    ).toMatchObject({ name: "kimi", model: "kimi-for-coding", env: { KIMI_API_KEY: "test-key" } });
  });

  test("uses the established provider priority", () => {
    expect(
      resolveProvider({ OPENROUTER_API_KEY: "router", GEMINI_API_KEY: "google" }),
    ).toMatchObject({ name: "openrouter" });
  });

  test("selects Kimi automatically when it is the only configured provider", () => {
    expect(
      resolveProvider({ KIMI_API_KEY: "test-key" }),
    ).toMatchObject({ name: "kimi", model: "kimi-for-coding", env: { KIMI_API_KEY: "test-key" } });
  });

  test("fails clearly when no configured provider exists", () => {
    expect(() => resolveProvider({})).toThrow("API_KEY");
    expect(() => resolveProvider({ AGENTOS_PROVIDER: "openai" })).toThrow("AGENTOS_PROVIDER");
  });

  test("builds an explicit OpenAI API fallback after Kimi", () => {
    expect(resolveProviderChain({
      AGENTOS_PROVIDER: "kimi",
      AGENTOS_MODEL: "k3",
      KIMI_API_KEY: "kimi-key",
      AGENTOS_FALLBACK_PROVIDER: "openai",
      AGENTOS_FALLBACK_MODEL: "gpt-5.4",
      OPENAI_API_KEY: "openai-key",
    })).toEqual([
      { name: "kimi", model: "k3", env: { KIMI_API_KEY: "kimi-key" }, thinkingLevel: "low" },
      { name: "openai", model: "gpt-5.4", env: { OPENAI_API_KEY: "openai-key" }, thinkingLevel: "low" },
    ]);
  });

  test("builds an OpenAI Codex OAuth fallback from an auth file", () => {
    expect(resolveProviderChain({
      AGENTOS_PROVIDER: "kimi",
      AGENTOS_MODEL: "k3",
      KIMI_API_KEY: "kimi-key",
      AGENTOS_FALLBACK_PROVIDER: "openai-codex",
      AGENTOS_FALLBACK_MODEL: "gpt-5.4",
      AGENTOS_CODEX_AUTH_FILE: "/secure/codex-auth.json",
    })).toEqual([
      { name: "kimi", model: "k3", env: { KIMI_API_KEY: "kimi-key" }, thinkingLevel: "low" },
      {
        name: "openai-codex",
        model: "gpt-5.4",
        env: {},
        authFile: "/secure/codex-auth.json",
        thinkingLevel: "low",
      },
    ]);
  });

  test("requires the fallback provider credential", () => {
    expect(() => resolveProviderChain({
      KIMI_API_KEY: "kimi-key",
      AGENTOS_FALLBACK_PROVIDER: "openai",
    })).toThrow("AGENTOS_FALLBACK_PROVIDER");
  });
});
