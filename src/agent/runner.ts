import {
  AgentOs,
  type AgentOsSidecar,
  type JsonRpcResponse,
  type SessionEventHandler,
} from "@rivet-dev/agentos-core";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isProviderCapacityError, type ProviderConfig } from "../config/provider.js";
import {
  AGENT_WORKSPACE,
  SANDBOX_PI_NODE_MODULES,
  SANDBOX_WORKSPACE,
  type SandboxWorkspace,
} from "../sandbox/runtime.js";

export interface AgentVm {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  createSession(agentType: string, options?: { cwd?: string; env?: Record<string, string> }): Promise<{ sessionId: string }>;
  prompt(sessionId: string, text: string): Promise<{ text: string; response?: JsonRpcResponse }>;
  onSessionEvent?(sessionId: string, handler: SessionEventHandler): () => void;
  closeSession(sessionId: string): void;
  dispose(): Promise<void>;
}

export interface AgentOsRuntime {
  createSidecar(options: { frameTimeoutMs: number }): Promise<AgentOsSidecar>;
  create(options: Parameters<typeof AgentOs.create>[0]): Promise<AgentVm>;
}

export interface AgentSkillProjection {
  name: string;
  content: string;
}

export const PI_AGENT_OUTPUT_ERROR_CODE = "agent_output_missing";

export class PiAgentOutputError extends Error {
  readonly code = PI_AGENT_OUTPUT_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "PiAgentOutputError";
  }
}

const DEFAULT_PI_TIMEOUT_MS = 30 * 60_000;
const SIDECAR_FRAME_TIMEOUT_BUFFER_MS = 60_000;
const SANDBOX_PI_HOME = "/tmp/shipwright-pi-home";
const SANDBOX_PI_AGENT_DIR = "/tmp/shipwright-pi-agent";
const SANDBOX_PI_CLI = `${SANDBOX_PI_NODE_MODULES}/@mariozechner/pi-coding-agent/dist/cli.js`;
const EMPTY_TURN_RECOVERY_PROMPT = [
  "Your previous turn completed without a final response.",
  "Resume the original task, finish any required workspace artifact, and return the requested final response now.",
  "Do not repeat completed edits or perform publication actions.",
].join(" ");
const AGENTOS_SOFTWARE_PACKAGES = [
  "@agentos-software/coreutils",
  "@agentos-software/sed",
  "@agentos-software/grep",
  "@agentos-software/gawk",
  "@agentos-software/findutils",
  "@agentos-software/diffutils",
  "@agentos-software/tar",
  "@agentos-software/gzip",
  "@agentos-software/pi",
] as const;

function resolveAgentOsSoftware(): Array<{ packagePath: string }> {
  return AGENTOS_SOFTWARE_PACKAGES.map((packageName) => {
    const entryPath = fileURLToPath(import.meta.resolve(packageName));
    const packagePath = join(dirname(entryPath), "package.aospkg");
    if (!statSync(packagePath).isFile()) {
      throw new Error(`AgentOS software archive is not a file: ${packageName}`);
    }
    return { packagePath };
  });
}

function piModelsConfig(provider: ProviderConfig): string | undefined {
  if (provider.name !== "kimi") return undefined;
  return JSON.stringify({
    providers: {
      kimi: {
        api: "anthropic-messages",
        apiKey: "KIMI_API_KEY",
        authHeader: true,
        baseUrl: "https://api.kimi.com/coding",
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

function piAuthConfig(provider: ProviderConfig): string | undefined {
  if (provider.name !== "openai-codex") return undefined;
  if (!provider.authFile) throw new Error("OpenAI Codex auth file is not configured");

  let auth: unknown;
  try {
    const metadata = statSync(provider.authFile);
    const processUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !metadata.isFile()
      || (metadata.mode & 0o077) !== 0
      || (processUid !== undefined && metadata.uid !== processUid)
    ) {
      throw new Error("unsafe auth file");
    }
    auth = JSON.parse(readFileSync(provider.authFile, "utf8"));
  } catch {
    throw new Error("OpenAI Codex auth file is unreadable, invalid, or not owner-only");
  }
  const tokens = asRecord(asRecord(auth)?.tokens);
  const access = stringField(tokens, "access_token");
  const refresh = stringField(tokens, "refresh_token");
  const accountId = stringField(tokens, "account_id");
  if (!access || !refresh || !accountId) {
    throw new Error("OpenAI Codex auth file is missing OAuth token fields");
  }
  const expires = jwtExpiryMs(access);
  return JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access,
      refresh,
      expires,
      accountId,
    },
  });
}

function assertSafeSkillName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`invalid skill name: ${name}`);
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function jwtExpiryMs(token: string): number {
  try {
    const payload = asRecord(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
    if (typeof payload?.exp === "number" && Number.isFinite(payload.exp)) return payload.exp * 1000;
  } catch {
    // Normalize token parsing failures below without exposing token material.
  }
  throw new Error("OpenAI Codex auth file contains an invalid access token");
}

export async function runPiAgent(
  vm: AgentVm,
  provider: ProviderConfig,
  prompt: string,
  timeoutMs = DEFAULT_PI_TIMEOUT_MS,
  skills: AgentSkillProjection[] = [],
): Promise<string> {
  let sessionId: string | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    await vm.mkdir("/home/agentos/.pi/agent", { recursive: true });
    await vm.writeFile(
      "/home/agentos/.pi/agent/settings.json",
      JSON.stringify({
        defaultProvider: provider.name,
        defaultModel: provider.model,
        defaultThinkingLevel: provider.thinkingLevel,
      }),
    );
    const authConfig = piAuthConfig(provider);
    if (authConfig) await vm.writeFile("/home/agentos/.pi/agent/auth.json", authConfig);
    const modelsConfig = piModelsConfig(provider);
    if (modelsConfig) await vm.writeFile("/home/agentos/.pi/agent/models.json", modelsConfig);
    if (skills.length > 0) {
      // Pi loads extensions to force resource/skill discovery. Prefer a .ts no-op:
      // .cjs/.js/.mjs stubs currently break AgentOS session/new host-path inspection.
      await vm.mkdir("/home/agentos/.pi/agent/extensions", { recursive: true });
      await vm.writeFile(
        "/home/agentos/.pi/agent/extensions/enable-resources.ts",
        "export default function enableResources() {}\n",
      );
      for (const skill of skills) {
        assertSafeSkillName(skill.name);
        const directory = `/home/agentos/.pi/agent/skills/${skill.name}`;
        await vm.mkdir(directory, { recursive: true });
        await vm.writeFile(`${directory}/SKILL.md`, skill.content);
      }
    }
    ({ sessionId } = await vm.createSession("pi", {
      cwd: AGENT_WORKSPACE,
      env: {
        HOME: "/home/agentos",
        PI_CODING_AGENT_DIR: "/home/agentos/.pi/agent",
        ...provider.env,
      },
    }));
    const diagnostics = createSessionDiagnostics();
    unsubscribe = vm.onSessionEvent?.(sessionId, diagnostics.observe);
    const result = await Promise.race([
      runPromptTurns(vm, sessionId, prompt, diagnostics.summary),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Pi agent timed out")), timeoutMs);
      }),
    ]);
    return result.text;
  } finally {
    if (timeout) clearTimeout(timeout);
    unsubscribe?.();
    if (sessionId) vm.closeSession(sessionId);
    await vm.dispose();
  }
}

export async function runSandboxPiAgent(
  workspace: SandboxWorkspace,
  provider: ProviderConfig,
  prompt: string,
  timeoutMs = DEFAULT_PI_TIMEOUT_MS,
  skills: AgentSkillProjection[] = [],
): Promise<string> {
  const authConfig = piAuthConfig(provider);
  if (!authConfig) throw new Error("sandbox Pi runner requires OpenAI Codex OAuth");
  for (const skill of skills) assertSafeSkillName(skill.name);

  try {
    await workspace.runOrThrow("OpenAI Codex Pi workspace preparation", {
      command: "mkdir",
      args: ["-p", SANDBOX_PI_HOME, `${SANDBOX_PI_AGENT_DIR}/skills`],
      cwd: "/",
    });
    await workspace.runOrThrow("OpenAI Codex Pi credential permissions", {
      command: "chmod",
      args: ["700", SANDBOX_PI_HOME, SANDBOX_PI_AGENT_DIR, `${SANDBOX_PI_AGENT_DIR}/skills`],
      cwd: "/",
    });
    await workspace.client.writeFsFile({ path: `${SANDBOX_PI_AGENT_DIR}/auth.json` }, authConfig);
    for (const skill of skills) {
      const skillDirectory = `${SANDBOX_PI_AGENT_DIR}/skills/${skill.name}`;
      await workspace.runOrThrow("OpenAI Codex Pi skill preparation", {
        command: "mkdir",
        args: ["-p", skillDirectory],
        cwd: "/",
      });
      await workspace.client.writeFsFile({ path: `${skillDirectory}/SKILL.md` }, skill.content);
    }
    await workspace.runOrThrow("OpenAI Codex Pi auth permissions", {
      command: "chmod",
      args: ["600", `${SANDBOX_PI_AGENT_DIR}/auth.json`],
      cwd: "/",
    });

    const result = await workspace.run({
      command: "node",
      args: [
        SANDBOX_PI_CLI,
        "--provider", provider.name,
        "--model", provider.model,
        "--thinking", provider.thinkingLevel,
        "--no-session",
        "--no-extensions",
        "--no-prompt-templates",
        "--no-themes",
        "-p", prompt,
      ],
      cwd: SANDBOX_WORKSPACE,
      env: {
        HOME: SANDBOX_PI_HOME,
        PI_CODING_AGENT_DIR: SANDBOX_PI_AGENT_DIR,
        ...provider.env,
      },
      timeoutMs,
    });
    if (result.timedOut) throw new Error("OpenAI Codex Pi CLI timed out");
    if (result.stdoutTruncated || result.stderrTruncated) {
      throw new Error("OpenAI Codex Pi CLI output exceeded the configured limit");
    }
    if (result.exitCode !== 0) {
      const upstream = `${result.stderr}\n${result.stdout}`;
      if (isProviderCapacityError(upstream)) {
        throw new Error("OpenAI Codex provider capacity exhausted");
      }
      if (/\b(?:401|403|unauthori[sz]ed|forbidden|authentication|invalid_grant|login required|access token|refresh token)\b/i.test(upstream)) {
        throw new Error("OpenAI Codex OAuth authentication failed");
      }
      throw new Error(`OpenAI Codex Pi CLI failed with exit ${result.exitCode}`);
    }
    if (!result.stdout.trim()) {
      throw new PiAgentOutputError("OpenAI Codex Pi CLI completed without text output");
    }
    return result.stdout;
  } finally {
    try {
      await workspace.run({
        command: "rm",
        args: ["-rf", "--", SANDBOX_PI_AGENT_DIR, SANDBOX_PI_HOME],
        cwd: "/",
      });
    } catch {
      // The disposable sandbox is destroyed by the owning pipeline.
    }
  }
}

async function runPromptTurns(
  vm: AgentVm,
  sessionId: string,
  prompt: string,
  diagnostics: () => string,
): Promise<{ text: string; response?: JsonRpcResponse }> {
  let result = await vm.prompt(sessionId, prompt);
  assertSuccessfulPrompt(result, diagnostics());
  if (result.text.trim()) return result;
  if (promptStopReason(result) !== "end_turn") {
    throw new PiAgentOutputError(
      `Pi agent completed without text output (${promptResultSummary(result)}; ${diagnostics()})`,
    );
  }

  result = await vm.prompt(sessionId, EMPTY_TURN_RECOVERY_PROMPT);
  assertSuccessfulPrompt(result, diagnostics());
  if (!result.text.trim()) {
    throw new PiAgentOutputError(
      `Pi agent completed twice without text output (${promptResultSummary(result)}; ${diagnostics()})`,
    );
  }
  return result;
}

function assertSuccessfulPrompt(
  result: { response?: JsonRpcResponse },
  diagnostics: string,
): void {
  const error = result.response?.error;
  if (!error) return;
  throw new Error(
    `Pi agent request failed (RPC ${error.code}): ${error.message} (${diagnostics})`,
  );
}

function promptResultSummary(result: { response?: JsonRpcResponse }): string {
  return `stopReason=${promptStopReason(result)}`;
}

function promptStopReason(result: { response?: JsonRpcResponse }): string {
  const responseResult = asRecord(result.response?.result);
  return typeof responseResult?.stopReason === "string"
    ? responseResult.stopReason
    : "unknown";
}

function createSessionDiagnostics(): {
  observe: SessionEventHandler;
  summary: () => string;
} {
  let agentMessageChunks = 0;
  let agentThoughtChunks = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  return {
    observe(event) {
      const params = asRecord(event.params);
      const update = asRecord(params?.update);
      switch (update?.sessionUpdate) {
        case "agent_message_chunk": agentMessageChunks += 1; break;
        case "agent_thought_chunk": agentThoughtChunks += 1; break;
        case "tool_call": toolCalls += 1; break;
        case "tool_call_update":
          if (update.status === "failed") toolFailures += 1;
          break;
      }
    },
    summary: () => [
      `agentMessageChunks=${agentMessageChunks}`,
      `agentThoughtChunks=${agentThoughtChunks}`,
      `toolCalls=${toolCalls}`,
      `toolFailures=${toolFailures}`,
    ].join(", "),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

export async function createAndRunPiAgent(
  workspace: SandboxWorkspace,
  provider: ProviderConfig,
  prompt: string,
  timeoutMs?: number,
  skills: AgentSkillProjection[] = [],
  runtime: AgentOsRuntime = AgentOs,
): Promise<string> {
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_PI_TIMEOUT_MS;
  if (provider.name === "openai-codex") {
    return runSandboxPiAgent(workspace, provider, prompt, effectiveTimeoutMs, skills);
  }
  const runtimeDeadlineMs = effectiveTimeoutMs + SIDECAR_FRAME_TIMEOUT_BUFFER_MS;
  const sidecar = await runtime.createSidecar({ frameTimeoutMs: runtimeDeadlineMs });
  try {
    const vm = await runtime.create({
      // Nitro bundles every package's `new URL("./package.aospkg",
      // import.meta.url)` into shared chunks. Those references then collide and
      // point at missing output assets. Resolve the host-installed archives
      // directly and opt out of AgentOS's bundled defaults.
      defaultSoftware: false,
      software: resolveAgentOsSoftware(),
      mounts: [workspace.createMount()],
      toolKits: [workspace.createToolkit()],
      sidecar: { kind: "explicit", handle: sidecar },
      limits: {
        jsRuntime: {
          cpuTimeLimitMs: runtimeDeadlineMs,
          wallClockLimitMs: runtimeDeadlineMs,
        },
      },
    });
    return await runPiAgent(vm, provider, prompt, effectiveTimeoutMs, skills);
  } finally {
    await sidecar.dispose();
  }
}
