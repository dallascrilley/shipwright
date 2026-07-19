import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProviderConfig } from "../config/provider.js";

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
  readonly software: "pi";
  readonly provider: ProviderConfig["name"];
  readonly model: string;
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
  verification: { command: string; exitCode: number | null; passed: boolean };
  commitSha?: string;
  pullRequestUrl?: string;
  errorCode?: string;
}

const TOKEN_PATTERNS = [
  /gh[psuor]_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g,
  /https:\/\/x-access-token:[^@\s]+@github\.com/gi,
];

export function redactSecrets(input: string): string {
  return TOKEN_PATTERNS.reduce((value, pattern) => value.replace(pattern, "[REDACTED]"), input);
}

export async function writeReceipt(path: string, receipt: RunReceipt): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const serialized = redactSecrets(`${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(temporaryPath, serialized, { mode: 0o600 });
  await rename(temporaryPath, path);
}
