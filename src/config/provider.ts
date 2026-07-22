export interface ProviderConfig {
  env: Record<string, string>;
  name: "anthropic" | "openrouter" | "openai" | "google" | "kimi";
  model: string;
}

type Environment = Record<string, string | undefined>;

export const PROVIDER_CAPACITY_ERROR_CODE = "provider_quota_exhausted";

const PROVIDER_CAPACITY_SIGNATURES: readonly RegExp[] = [
  /usage limit/i,
  /\bquota\b/i,
  /billing cycle/i,
  /upgrade your plan/i,
  /purchase extra usage/i,
  /insufficient (?:credit|quota|balance)/i,
  /out of credits?/i,
  /exceeded your (?:usage|credit)/i,
  /rate limit/i,
  /capacity exhausted/i,
  /provider (?:is )?(?:overloaded|at capacity)/i,
];

export function isProviderCapacityError(message: string): boolean {
  return PROVIDER_CAPACITY_SIGNATURES.some((pattern) => pattern.test(message));
}

function configuredProvider(
  key: string | undefined,
  envName: string,
  name: ProviderConfig["name"],
  model: string,
): ProviderConfig | undefined {
  return key ? { env: { [envName]: key }, name, model } : undefined;
}

function configuredProviders(env: Environment): Record<string, ProviderConfig | undefined> {
  return {
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
}

export function resolveProvider(env: Environment = process.env): ProviderConfig {
  const providers = configuredProviders(env);

  const requested = env.AGENTOS_PROVIDER;
  const provider = requested
    ? providers[requested]
    : providers.anthropic ??
      providers.openrouter ??
      providers.openai ??
      providers.google ??
      providers.kimi;
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

export function resolveProviderChain(env: Environment = process.env): ProviderConfig[] {
  const primary = resolveProvider(env);
  const requestedFallback = env.AGENTOS_FALLBACK_PROVIDER?.trim();
  if (!requestedFallback) return [primary];

  const fallback = configuredProviders(env)[requestedFallback];
  if (!fallback) {
    throw new Error(
      `AGENTOS_FALLBACK_PROVIDER=${requestedFallback} is not configured with a matching API key`,
    );
  }
  const fallbackModel = env.AGENTOS_FALLBACK_MODEL?.trim();
  const configuredFallback = fallbackModel ? { ...fallback, model: fallbackModel } : fallback;
  if (
    configuredFallback.name === primary.name &&
    configuredFallback.model === primary.model
  ) {
    throw new Error("fallback provider and model must differ from the primary provider and model");
  }
  return [primary, configuredFallback];
}
