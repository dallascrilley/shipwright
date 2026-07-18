import { createClient } from "@rivet-dev/agentos/client";
import type { registry } from "./server.js";

const endpoint = process.env.AGENTOS_ENDPOINT ?? "http://localhost:6420";

interface Provider {
  env: Record<string, string>;
  name: string;
  model: string;
}

function configuredProvider(
  key: string | undefined,
  envName: string,
  name: string,
  model: string,
): Provider | undefined {
  return key ? { env: { [envName]: key }, name, model } : undefined;
}

const providers: Record<string, Provider | undefined> = {
  anthropic: configuredProvider(
    process.env.ANTHROPIC_API_KEY,
    "ANTHROPIC_API_KEY",
    "anthropic",
    "claude-opus-4-6",
  ),
  openrouter: configuredProvider(
    process.env.OPENROUTER_API_KEY,
    "OPENROUTER_API_KEY",
    "openrouter",
    "openai/gpt-5.1-codex",
  ),
  openai: configuredProvider(
    process.env.OPENAI_API_KEY,
    "OPENAI_API_KEY",
    "openai",
    "gpt-4.1-mini",
  ),
  google: configuredProvider(
    process.env.GEMINI_API_KEY,
    "GEMINI_API_KEY",
    "google",
    "gemini-2.5-flash",
  ),
};
const requestedProvider = process.env.AGENTOS_PROVIDER;
const provider = requestedProvider
  ? providers[requestedProvider]
  : providers.anthropic ?? providers.openrouter ?? providers.openai ?? providers.google;

if (!provider) {
  throw new Error(
    requestedProvider
      ? `AGENTOS_PROVIDER=${requestedProvider} is not configured with a matching API key`
      : "ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY is required to create the Pi session",
  );
}

const client = createClient<typeof registry>({ endpoint });
const vm = client.vm.getOrCreate(process.env.AGENTOS_VM_NAME ?? "getting-started-agent");

async function whenRunnerReady<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      return await action();
    } catch (error) {
      const isRunnerStarting =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "no_runner_config_configured";

      if (!isRunnerStarting || attempt === 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error("agentOS runner did not become ready");
}

await whenRunnerReady(() => vm.exec("mkdir -p /home/agentos/.pi/agent"));
await vm.writeFile(
  "/home/agentos/.pi/agent/settings.json",
  JSON.stringify({ defaultProvider: provider.name, defaultModel: provider.model }),
);
console.error(`[agentOS] VM ready; using ${provider.name}/${provider.model}`);

const sessionId = await vm.createSession("pi", { env: provider.env });
console.error(`[agentOS] Pi session created: ${sessionId}`);

try {
  console.error("[agentOS] sending prompt");
  const response = await vm.sendPrompt(
    sessionId,
    "Reply with exactly AGENTOS_ROUND_TRIP_OK and no other text.",
  );

  if (!response.text.includes("AGENTOS_ROUND_TRIP_OK")) {
    throw new Error(`Pi returned an unexpected response: ${response.text}`);
  }

  console.error("[agentOS] response received");
  console.log(response.text.trim());
} finally {
  await vm.closeSession(sessionId);
}
