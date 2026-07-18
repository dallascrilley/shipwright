import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostDirBackend, type ToolKit } from "@rivet-dev/agentos-core";
import { SandboxAgent, type ProcessRunRequest, type ProcessRunResponse } from "sandbox-agent";
import { docker } from "sandbox-agent/docker";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const SANDBOX_WORKSPACE = "/home/sandbox/workspace";
export const AGENT_WORKSPACE = "/workspace";

export interface CloneInput {
  owner: string;
  repo: string;
  defaultBranch: string;
  baseSha: string;
  branch: string;
  token: string;
}

export interface ChangeInspection {
  changedFiles: string[];
  patch: string;
  patchBytes: number;
}

export function parseNulList(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

export function requireSuccessfulCommand(label: string, result: ProcessRunResponse): ProcessRunResponse {
  if (result.timedOut) throw new Error(`${label} timed out`);
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new Error(`${label} output exceeded the configured limit`);
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return result;
}

export class SandboxWorkspace {
  private constructor(readonly client: SandboxAgent, private readonly hostWorkspace: string) {}

  static async start(): Promise<SandboxWorkspace> {
    const hostWorkspace = await mkdtemp(join(tmpdir(), "programming-agent-workspace-"));
    try {
      const client = await SandboxAgent.start({
        sandbox: docker({ binds: [`${hostWorkspace}:${SANDBOX_WORKSPACE}`] }),
      });
      return new SandboxWorkspace(client, hostWorkspace);
    } catch (error) {
      await rm(hostWorkspace, { recursive: true });
      throw error;
    }
  }

  async run(request: ProcessRunRequest): Promise<ProcessRunResponse> {
    return this.client.runProcess({
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      ...request,
    });
  }

  async runOrThrow(label: string, request: ProcessRunRequest): Promise<ProcessRunResponse> {
    return requireSuccessfulCommand(label, await this.run(request));
  }

  async initialize(): Promise<void> {
    await this.runOrThrow("workspace initialization", {
      command: "sh",
      args: ["-lc", `mkdir -p ${SANDBOX_WORKSPACE} && test -z "$(find ${SANDBOX_WORKSPACE} -mindepth 1 -maxdepth 1 -print -quit)"`],
      cwd: "/",
    });
  }

  createMount() {
    return {
      path: "/workspace",
      plugin: createHostDirBackend({ hostPath: this.hostWorkspace, readOnly: false }),
      readOnly: false,
    };
  }

  createToolkit(): ToolKit {
    return {
      name: "sandbox",
      description: "Execute commands in the isolated full-toolchain sandbox.",
      tools: {
        "run-command": {
          description: "Run a command synchronously in the sandbox repository.",
          inputSchema: z.object({
            command: z.string(),
            args: z.array(z.string()).optional(),
            cwd: z.string().optional(),
            env: z.record(z.string(), z.string()).optional(),
            timeoutMs: z.number().int().positive().max(DEFAULT_TIMEOUT_MS).optional(),
          }),
          timeout: DEFAULT_TIMEOUT_MS,
          execute: async (input) => {
            const cwd = input.cwd ?? AGENT_WORKSPACE;
            if (cwd !== AGENT_WORKSPACE && !cwd.startsWith(`${AGENT_WORKSPACE}/`)) {
              throw new Error("sandbox command cwd must remain inside the repository workspace");
            }
            const result = await this.run({
              command: input.command,
              args: input.args,
              cwd: cwd.replace(AGENT_WORKSPACE, SANDBOX_WORKSPACE),
              env: input.env,
              timeoutMs: input.timeoutMs,
            });
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              durationMs: result.durationMs,
            };
          },
        },
      },
    };
  }

  async prepareForAgent(): Promise<void> {
    await this.runOrThrow("agent workspace preparation", {
      command: "mkdir",
      args: ["-p", `${SANDBOX_WORKSPACE}/.pi`],
      cwd: SANDBOX_WORKSPACE,
    });
  }

  async clone(input: CloneInput): Promise<void> {
    await this.initialize();
    await this.withGitCredentials(input.token, async (env) => {
      await this.runOrThrow("repository clone", {
        command: "git",
        args: [
          "clone",
          "--branch",
          input.defaultBranch,
          "--single-branch",
          `https://github.com/${input.owner}/${input.repo}.git`,
          SANDBOX_WORKSPACE,
        ],
        cwd: "/",
        env,
      });
    });

    const head = await this.runOrThrow("base SHA check", {
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: SANDBOX_WORKSPACE,
    });
    if (head.stdout.trim() !== input.baseSha) {
      throw new Error(`repository base moved: expected ${input.baseSha}, received ${head.stdout.trim()}`);
    }
    await this.runOrThrow("branch creation", {
      command: "git",
      args: ["switch", "-c", input.branch],
      cwd: SANDBOX_WORKSPACE,
    });
  }

  async verify(command: string, timeoutMs: number): Promise<ProcessRunResponse> {
    return this.run({
      command: "sh",
      args: ["-lc", command],
      cwd: SANDBOX_WORKSPACE,
      timeoutMs,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });
  }

  async inspectChanges(): Promise<ChangeInspection> {
    const tracked = await this.runOrThrow("tracked change listing", {
      command: "git",
      args: ["diff", "--name-only", "-z"],
      cwd: SANDBOX_WORKSPACE,
    });
    const untracked = await this.runOrThrow("untracked change listing", {
      command: "git",
      args: ["ls-files", "--others", "--exclude-standard", "-z"],
      cwd: SANDBOX_WORKSPACE,
    });
    const changedFiles = [...new Set([...parseNulList(tracked.stdout), ...parseNulList(untracked.stdout)])].sort();

    if (untracked.stdout) {
      await this.runOrThrow("untracked diff preparation", {
        command: "git",
        args: ["add", "--intent-to-add", "--", ...parseNulList(untracked.stdout)],
        cwd: SANDBOX_WORKSPACE,
      });
    }
    const diff = await this.runOrThrow("change diff", {
      command: "git",
      args: ["diff", "--binary", "--no-ext-diff"],
      cwd: SANDBOX_WORKSPACE,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES + 1,
    });
    return {
      changedFiles,
      patch: diff.stdout,
      patchBytes: new TextEncoder().encode(diff.stdout).byteLength,
    };
  }

  async assertRunIdentity(baseSha: string, branch: string): Promise<void> {
    const actualBranch = await this.runOrThrow("branch identity check", {
      command: "git",
      args: ["branch", "--show-current"],
      cwd: SANDBOX_WORKSPACE,
    });
    const actualHead = await this.runOrThrow("pre-commit base check", {
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: SANDBOX_WORKSPACE,
    });
    if (actualBranch.stdout.trim() !== branch || actualHead.stdout.trim() !== baseSha) {
      throw new Error("repository identity changed after authorization");
    }
  }

  async commit(message: string): Promise<string> {
    await this.runOrThrow("git identity", {
      command: "git",
      args: ["config", "user.name", "Programming Agent[bot]"],
      cwd: SANDBOX_WORKSPACE,
    });
    await this.runOrThrow("git email", {
      command: "git",
      args: ["config", "user.email", "programming-agent[bot]@users.noreply.github.com"],
      cwd: SANDBOX_WORKSPACE,
    });
    await this.runOrThrow("change staging", {
      command: "git",
      args: ["add", "--all"],
      cwd: SANDBOX_WORKSPACE,
    });
    await this.runOrThrow("change commit", {
      command: "git",
      args: ["commit", "-m", message],
      cwd: SANDBOX_WORKSPACE,
    });
    return (
      await this.runOrThrow("commit SHA", {
        command: "git",
        args: ["rev-parse", "HEAD"],
        cwd: SANDBOX_WORKSPACE,
      })
    ).stdout.trim();
  }

  async push(branch: string, token: string): Promise<void> {
    await this.withGitCredentials(token, async (env) => {
      await this.runOrThrow("branch push", {
        command: "git",
        args: ["push", "--set-upstream", "origin", branch],
        cwd: SANDBOX_WORKSPACE,
        env,
      });
    });
  }

  async destroy(): Promise<void> {
    try {
      await this.client.destroySandbox();
    } finally {
      try {
        await this.client.dispose();
      } finally {
        await rm(this.hostWorkspace, { recursive: true });
      }
    }
  }

  private async withGitCredentials<T>(
    token: string,
    action: (env: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    const id = randomUUID();
    const helperPath = `/tmp/agentos-askpass-${id}`;
    const tokenPath = `/tmp/agentos-token-${id}`;
    const helper = [
      "#!/bin/sh",
      'case "$1" in',
      '  *Username*) printf "%s\\n" "x-access-token" ;;',
      '  *) cat "$GIT_TOKEN_FILE" ;;',
      "esac",
      "",
    ].join("\n");

    await this.client.writeFsFile({ path: helperPath }, helper);
    await this.client.writeFsFile({ path: tokenPath }, token);
    try {
      await this.runOrThrow("credential helper permissions", {
        command: "chmod",
        args: ["700", helperPath, tokenPath],
        cwd: "/",
      });
      return await action({
        GIT_ASKPASS: helperPath,
        GIT_TOKEN_FILE: tokenPath,
        GIT_TERMINAL_PROMPT: "0",
      });
    } finally {
      await Promise.all([
        this.client.deleteFsEntry({ path: helperPath }),
        this.client.deleteFsEntry({ path: tokenPath }),
      ]);
    }
  }
}
