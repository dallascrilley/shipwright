import pi from "@agentos-software/pi";
import { AgentOs } from "@rivet-dev/agentos-core";
import type { ProviderConfig } from "../config/provider.js";
import { AGENT_WORKSPACE, type SandboxWorkspace } from "../sandbox/runtime.js";

export interface AgentVm {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  createSession(agentType: string, options?: { cwd?: string; env?: Record<string, string> }): Promise<{ sessionId: string }>;
  prompt(sessionId: string, text: string): Promise<{ text: string }>;
  closeSession(sessionId: string): void;
  dispose(): Promise<void>;
}

function piModelsConfig(provider: ProviderConfig): string | undefined {
  if (provider.name !== "kimi") return undefined;
  return JSON.stringify({
    providers: {
      kimi: {
        api: "openai-completions",
        apiKey: "KIMI_API_KEY",
        authHeader: true,
        baseUrl: "https://api.kimi.com/coding/v1",
        models: [
          {
            contextWindow: 1_048_576,
            id: provider.model,
            input: ["text", "image"],
            maxTokens: 32_768,
            reasoning: true,
            compat: {
              supportsDeveloperRole: false,
            },
          },
        ],
      },
    },
  });
}

export async function runPiAgent(
  vm: AgentVm,
  provider: ProviderConfig,
  prompt: string,
  timeoutMs = 30 * 60_000,
): Promise<string> {
  let sessionId: string | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await vm.mkdir("/home/agentos/.pi/agent", { recursive: true });
    await vm.writeFile(
      "/home/agentos/.pi/agent/settings.json",
      JSON.stringify({ defaultProvider: provider.name, defaultModel: provider.model }),
    );
    const modelsConfig = piModelsConfig(provider);
    if (modelsConfig) await vm.writeFile("/home/agentos/.pi/agent/models.json", modelsConfig);
    ({ sessionId } = await vm.createSession("pi", {
      cwd: AGENT_WORKSPACE,
      env: {
        HOME: "/home/agentos",
        PI_CODING_AGENT_DIR: "/home/agentos/.pi/agent",
        ...provider.env,
      },
    }));
    const result = await Promise.race([
      vm.prompt(sessionId, prompt),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Pi agent timed out")), timeoutMs);
      }),
    ]);
    return result.text;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (sessionId) vm.closeSession(sessionId);
    await vm.dispose();
  }
}

export async function createAndRunPiAgent(
  workspace: SandboxWorkspace,
  provider: ProviderConfig,
  prompt: string,
  timeoutMs?: number,
): Promise<string> {
  const vm = await AgentOs.create({
    software: [pi],
    mounts: [workspace.createMount()],
    toolKits: [workspace.createToolkit()],
  });
  return runPiAgent(vm, provider, prompt, timeoutMs);
}
