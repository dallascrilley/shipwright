import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProviderConfig } from "../config/provider.js";
import { redactSecrets } from "./secret-safety.js";


export type RunPhase =
  | "intake"
  | "workspace"
  | "agent"
  | "verify"
  | "policy"
  | "publish"
  | "complete";

export interface AgentExecution {
  readonly runtime: "agentos";
  software: "codex" | "pi";
  provider: ProviderConfig["name"];
  model: string;
  fallbackUsed?: boolean;
  attempts?: Array<{
    provider: ProviderConfig["name"];
    model: string;
    outcome: "capacity_failed" | "failed" | "succeeded";
  }>;
}

export interface DemoExecution {
  readonly runtime: "demo";
  readonly software: "demo";
  readonly provider: "demo";
  readonly model: "demo";
}

export type RunExecution = AgentExecution | DemoExecution;

export interface RunReceipt {
  runId: string;
  phase: RunPhase;
  issueUrl: string;
  execution: RunExecution;
  baseSha?: string;
  branch?: string;
  changedFiles: string[];
  verification: {
    command: string;
    exitCode: number | null;
    passed: boolean;
    stdoutTail?: string;
    stderrTail?: string;
  };
  commitSha?: string;
  pullRequestUrl?: string;
  errorCode?: string;
  errorMessage?: string;
}

export const VERIFICATION_TAIL_MAX_BYTES = 8 * 1024;

export { containsSecretLikeContent, redactSecrets } from "./secret-safety.js";

export function truncateTail(input: string, maxBytes = VERIFICATION_TAIL_MAX_BYTES): string {
  if (!input) return input;
  const encoded = new TextEncoder().encode(input);
  if (encoded.byteLength <= maxBytes) return input;
  const slice = encoded.slice(encoded.byteLength - maxBytes);
  return new TextDecoder().decode(slice);
}

export async function writeReceipt(path: string, receipt: RunReceipt): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const serialized = redactSecrets(`${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(temporaryPath, serialized, { mode: 0o600 });
  await rename(temporaryPath, path);
}
