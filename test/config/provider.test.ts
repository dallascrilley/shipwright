import { describe, expect, test } from "bun:test";
import { resolveProvider } from "../../src/config/provider.js";

describe("resolveProvider", () => {
  test("selects an explicitly requested configured provider", () => {
    expect(
      resolveProvider({ AGENTOS_PROVIDER: "openai", OPENAI_API_KEY: "test-key" }),
    ).toMatchObject({ name: "openai", model: "gpt-4.1-mini" });
  });

  test("supports an explicit model override", () => {
    expect(resolveProvider({ OPENAI_API_KEY: "key", AGENTOS_MODEL: "gpt-custom" }).model).toBe("gpt-custom");
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

  test("fails clearly when no configured provider exists", () => {
    expect(() => resolveProvider({})).toThrow("API_KEY");
    expect(() => resolveProvider({ AGENTOS_PROVIDER: "openai" })).toThrow("AGENTOS_PROVIDER");
  });
});
