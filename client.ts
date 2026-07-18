import { createClient } from "@rivet-dev/agentos/client";
import type { registry } from "./server.js";
import { resolveProvider } from "./src/config/provider.js";

const endpoint = process.env.AGENTOS_ENDPOINT ?? "http://localhost:6420";

const provider = resolveProvider();

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
