export interface ProviderConfig {
  env: Record<string, string>;
  name: "anthropic" | "openrouter" | "openai" | "google" | "kimi";
  model: string;
}

type Environment = Record<string, string | undefined>;

function configuredProvider(
  key: string | undefined,
  envName: string,
  name: ProviderConfig["name"],
  model: string,
): ProviderConfig | undefined {
  return key ? { env: { [envName]: key }, name, model } : undefined;
}

export function resolveProvider(env: Environment = process.env): ProviderConfig {
  const providers: Record<string, ProviderConfig | undefined> = {
    anthropic: configuredProvider(
      env.ANTHROPIC_API_KEY,
      "ANTHROPIC_API_KEY",
      "anthropic",
      "claude-opus-4-6",
    ),
    openrouter: configuredProvider(
      env.OPENROUTER_API_KEY,
      "OPENROUTER_API_KEY",
      "openrouter",
      "openai/gpt-5.1-codex",
    ),
    openai: configuredProvider(env.OPENAI_API_KEY, "OPENAI_API_KEY", "openai", "gpt-4.1-mini"),
    google: configuredProvider(env.GEMINI_API_KEY, "GEMINI_API_KEY", "google", "gemini-2.5-flash"),
    kimi: configuredProvider(env.KIMI_API_KEY, "KIMI_API_KEY", "kimi", "kimi-for-coding"),
  };

  const requested = env.AGENTOS_PROVIDER;
  const provider = requested
    ? providers[requested]
    : providers.anthropic ?? providers.openrouter ?? providers.openai ?? providers.google;
  if (!provider) {
    throw new Error(
      requested
        ? `AGENTOS_PROVIDER=${requested} is not configured with a matching API key`
        : "ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or KIMI_API_KEY is required",
    );
  }
  const model = env.AGENTOS_MODEL?.trim();
  return model ? { ...provider, model } : provider;
}
