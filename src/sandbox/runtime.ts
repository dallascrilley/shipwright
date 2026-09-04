import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHostDirBackend, type ToolKit } from "@rivet-dev/agentos-core";
import { SandboxAgent, type ProcessRunRequest, type ProcessRunResponse } from "sandbox-agent";
import { docker } from "sandbox-agent/docker";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const SANDBOX_WORKSPACE = "/home/sandbox/workspace";
export const SANDBOX_PI_NODE_MODULES = "/opt/shipwright/node_modules";
export const SANDBOX_BUN_EXECUTABLE = "/usr/local/bin/bun";
export const EXPECTED_SANDBOX_BUN_VERSION = "1.3.14";
export const AGENT_WORKSPACE = "/workspace";
export const DEFAULT_SANDBOX_IMAGE =
  "rivetdev/sandbox-agent@sha256:640cfb725a94b8a47967e0c2ec153d3ab267244f517f700e8f82f1e4d55b2ea2";
const execFileAsync = promisify(execFile);

async function createHostWorkspaceDirectory(): Promise<string> {
  // AgentOS host-dir mounts on macOS/OrbStack fail against /var/folders temp roots.
  // Prefer a home-local directory and always realpath through private/tmp symlinks.
  const preferredRoot = join(homedir(), ".shipwright", "workspaces");
  try {
    await mkdir(preferredRoot, { recursive: true, mode: 0o700 });
    return await realpath(await mkdtemp(join(preferredRoot, "run-")));
  } catch {
    return await realpath(await mkdtemp(join(tmpdir(), "shipwright-workspace-")));
  }
}

export interface CloneInput {
  owner: string;
  repo: string;
  defaultBranch: string;
  baseSha: string;
  branch: string;
  token: string;
}

export interface PullRequestCloneInput {
  owner: string;
  repo: string;
  headBranch: string;
  headSha: string;
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

export function resolveSandboxImage(configured?: string): string {
  const image = configured?.trim() || DEFAULT_SANDBOX_IMAGE;
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error("SHIPWRIGHT_SANDBOX_IMAGE must use an immutable sha256 digest");
  }
  return image;
}

export function resolveSandboxContainerUser(
  platform: NodeJS.Platform,
  uid: number | undefined,
  gid: number | undefined,
  dockerMode: string | undefined = process.env.SHIPWRIGHT_DOCKER_MODE,
): string | undefined {
  if (platform !== "linux") return undefined;
  if (dockerMode === "rootless") return "0:0";
  return uid !== undefined && gid !== undefined ? `${uid}:${gid}` : undefined;
}

export function resolvePiNodeModulesDirectory(): string {
  const entryPath = fileURLToPath(import.meta.resolve("@mariozechner/pi-coding-agent"));
  const packageRoot = dirname(dirname(entryPath));
  return dirname(dirname(packageRoot));
}

export function resolveBunExecutable(
  configured = process.env.SHIPWRIGHT_SANDBOX_BUN_PATH,
  home = homedir(),
): string {
  const candidate = configured?.trim()
    || join(home, ".shipwright", "tools", `bun-${EXPECTED_SANDBOX_BUN_VERSION}-linux`);
  try {
    const resolved = realpathSync(candidate);
    if (!isAbsolute(resolved) || resolved.includes(":") || resolved.includes("\n")) {
      throw new Error("unsafe bind path");
    }
    if (!statSync(resolved).isFile()) throw new Error("not a file");
    accessSync(resolved, constants.R_OK | constants.X_OK);
    return resolved;
  } catch {
    throw new Error(
      `sandbox Bun runtime is unavailable at ${candidate}; run bun run provision:sandbox-bun`,
    );
  }
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

export function requireExpectedBunVersion(result: ProcessRunResponse): string {
  const version = requireSuccessfulCommand("sandbox Bun preflight", result).stdout.trim();
  if (version !== EXPECTED_SANDBOX_BUN_VERSION) {
    throw new Error(
      `sandbox Bun preflight expected ${EXPECTED_SANDBOX_BUN_VERSION}, received ${version || "no version"}`,
    );
  }
  return version;
}

export class SandboxWorkspace {
  private authorizedLocalConfig?: string;
  private sandboxStopped = false;

  private constructor(readonly client: SandboxAgent, private readonly hostWorkspace: string) {}

  static async start(): Promise<SandboxWorkspace> {
    const hostWorkspace = await createHostWorkspaceDirectory();
    try {
      const containerUser = resolveSandboxContainerUser(
        process.platform,
        typeof process.getuid === "function" ? process.getuid() : undefined,
        typeof process.getgid === "function" ? process.getgid() : undefined,
        process.env.SHIPWRIGHT_DOCKER_MODE,
      );
      const client = await SandboxAgent.start({
        sandbox: docker({
          image: resolveSandboxImage(process.env.SHIPWRIGHT_SANDBOX_IMAGE),
          binds: [
            `${hostWorkspace}:${SANDBOX_WORKSPACE}`,
            `${resolvePiNodeModulesDirectory()}:${SANDBOX_PI_NODE_MODULES}:ro`,
            `${resolveBunExecutable()}:${SANDBOX_BUN_EXECUTABLE}:ro`,
          ],
          createContainerOptions: containerUser ? { User: containerUser } : undefined,
        }),
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
    requireExpectedBunVersion(await this.run({
      command: SANDBOX_BUN_EXECUTABLE,
      args: ["--version"],
      cwd: "/",
    }));
    await this.runOrThrow("workspace initialization", {
      command: "sh",
      args: ["-lc", `mkdir -p ${SANDBOX_WORKSPACE} && test -r ${SANDBOX_WORKSPACE} && test -w ${SANDBOX_WORKSPACE} && test -x ${SANDBOX_WORKSPACE} && test -z "$(find ${SANDBOX_WORKSPACE} -mindepth 1 -maxdepth 1 -print -quit)"`],
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
    await this.captureAuthorizedRepoConfig();
  }

  async clonePullRequest(input: PullRequestCloneInput): Promise<void> {
    await this.initialize();
    await this.withGitCredentials(input.token, async (env) => {
      await this.runOrThrow("pull request clone", {
        command: "git",
        args: [
          "clone",
          "--branch",
          input.headBranch,
          "--single-branch",
          `https://github.com/${input.owner}/${input.repo}.git`,
          SANDBOX_WORKSPACE,
        ],
        cwd: "/",
        env,
      });
    });
    const head = await this.runOrThrow("pull request head SHA check", {
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: SANDBOX_WORKSPACE,
    });
    if (head.stdout.trim() !== input.headSha) {
      throw new Error(`pull request head moved: expected ${input.headSha}, received ${head.stdout.trim()}`);
    }
    await this.captureAuthorizedRepoConfig();
  }

  async prepareReviewArtifact(path: string): Promise<void> {
    this.assertSafeArtifactPath(path);
    const tracked = await this.run({
      command: "git",
      args: ["ls-files", "--error-unmatch", "--", path],
      cwd: SANDBOX_WORKSPACE,
    });
    if (tracked.exitCode === 0) throw new Error("reserved review artifact path is already tracked");
    if (tracked.exitCode !== 1) requireSuccessfulCommand("review artifact reservation", tracked);
  }

  async readAndRemoveArtifact(path: string): Promise<string> {
    this.assertSafeArtifactPath(path);
    try {
      return (await this.runOrThrow("review outcome artifact", {
        command: "cat",
        args: [path],
        cwd: SANDBOX_WORKSPACE,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      })).stdout;
    } finally {
      await this.runOrThrow("review artifact unstaging", {
        command: "git",
        args: ["reset", "--quiet", "HEAD", "--", path],
        cwd: SANDBOX_WORKSPACE,
      });
      await this.run({
        command: "rm",
        args: ["-f", "--", path],
        cwd: SANDBOX_WORKSPACE,
      });
    }
  }

  async verify(command: string, timeoutMs: number): Promise<ProcessRunResponse> {
    // `sh -c`, never `sh -lc`: a login shell sources /etc/profile and
    // ~/.profile, and $HOME is outside the inspected workspace, so a login
    // shell would let the agent green any gate by writing ~/.profile. Clearing
    // ENV/BASH_ENV stops non-login sh/bash from sourcing an agent-named file.
    return this.run({
      command: "sh",
      args: ["-c", command],
      cwd: SANDBOX_WORKSPACE,
      env: { ENV: "", BASH_ENV: "" },
      timeoutMs,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });
  }

  async inspectChanges(authorizedHeadSha: string): Promise<ChangeInspection> {
    if (!/^[0-9a-f]{40}$/.test(authorizedHeadSha)) {
      throw new Error("inspectChanges requires a full authorized head SHA");
    }
    // Host git reads the repo-local .git/config, which lives in the
    // agent-writable workspace. A `git add`/`diff` applies clean/textconv
    // filters and consults core.fsmonitor, so an agent-planted
    // filter.<name>.clean or core.fsmonitor would execute on the HOST as the
    // service user. The clone-time capture predates any agent execution;
    // assert the local config is unchanged before staging anything.
    await this.assertAuthorizedRepoConfig();
    // Compute the change set with HOST git against the authorized head using a
    // scratch index. Host git ignores sandbox git config (fsmonitor/hooks) and
    // reads no global/system config; diffing against the fixed SHA (not HEAD)
    // defeats an agent `git commit`, and a fresh index built by read-tree
    // carries no skip-worktree/assume-unchanged bits, so `add -A` re-examines
    // every working-tree file. Ignored paths (e.g. node_modules) remain
    // invisible by git's design; gates must not depend on agent-writable
    // ignored content, and such paths should be named in the preset's
    // protectedPaths alongside .gitignore and lockfiles.
    const indexDirectory = await mkdtemp(join(tmpdir(), "shipwright-index-"));
    const indexPath = join(indexDirectory, "index");
    try {
      const indexEnv = { GIT_INDEX_FILE: indexPath };
      await this.hostGit(["read-tree", authorizedHeadSha], indexEnv);
      await this.hostGit(["-c", "core.hooksPath=/dev/null", "add", "-A"], indexEnv);
      const names = await this.hostGit(
        ["diff", "--cached", "--name-only", "-z", authorizedHeadSha],
        indexEnv,
      );
      const changedFiles = parseNulList(names).sort();
      const patch = await this.hostGit(
        ["diff", "--cached", "--binary", "--no-ext-diff", authorizedHeadSha],
        indexEnv,
      );
      return {
        changedFiles,
        patch,
        patchBytes: new TextEncoder().encode(patch).byteLength,
      };
    } finally {
      await rm(indexDirectory, { recursive: true, force: true });
    }
  }

  async assertRunIdentity(baseSha: string, branch: string): Promise<void> {
    const [actualBranch, actualHead, localConfig] = await Promise.all([
      this.hostGit(["branch", "--show-current"]),
      this.hostGit(["rev-parse", "HEAD"]),
      this.hostGit(["config", "--local", "--null", "--list"]),
    ]);
    if (actualBranch.trim() !== branch || actualHead.trim() !== baseSha) {
      throw new Error("repository identity changed after authorization");
    }
    if (!this.authorizedLocalConfig || localConfig !== this.authorizedLocalConfig) {
      throw new Error("repository Git configuration changed after authorization");
    }
  }

  async commit(message: string): Promise<string> {
    await this.hostGit(["-c", "core.hooksPath=/dev/null", "add", "--all"]);
    await this.hostGit([
      "-c", "core.hooksPath=/dev/null",
      "-c", "user.name=Shipwright[bot]",
      "-c", "user.email=shipwright[bot]@users.noreply.github.com",
      "commit", "-m", message,
    ]);
    return (await this.hostGit(["rev-parse", "HEAD"])).trim();
  }

  async push(branch: string, token: string): Promise<void> {
    const credentialDirectory = await mkdtemp(join(tmpdir(), "shipwright-credential-"));
    const helperPath = join(credentialDirectory, "askpass.sh");
    const tokenPath = join(credentialDirectory, "token");
    const helper = [
      "#!/bin/sh",
      'case "$1" in',
      '  *Username*) printf "%s\\n" "x-access-token" ;;',
      '  *) cat "$GIT_TOKEN_FILE" ;;',
      "esac",
      "",
    ].join("\n");
    try {
      await Promise.all([
        writeFile(helperPath, helper, { mode: 0o700 }),
        writeFile(tokenPath, token, { mode: 0o600 }),
      ]);
      await chmod(credentialDirectory, 0o700);
      await this.hostGit(
        ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "push", "--set-upstream", "origin", branch],
        { GIT_ASKPASS: helperPath, GIT_TOKEN_FILE: tokenPath, GIT_TERMINAL_PROMPT: "0" },
      );
    } finally {
      await rm(credentialDirectory, { recursive: true, force: true });
    }
  }

  async destroy(): Promise<void> {
    try {
      if (!this.sandboxStopped) await this.client.destroySandbox();
    } finally {
      try {
        await this.client.dispose();
      } finally {
        await rm(this.hostWorkspace, { recursive: true });
      }
    }
  }

  async quiesce(): Promise<void> {
    if (this.sandboxStopped) return;
    await this.client.destroySandbox();
    this.sandboxStopped = true;
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

  private assertSafeArtifactPath(path: string): void {
    if (!path || path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error("artifact path must remain inside the repository root");
    }
  }

  async captureAuthorizedRepoConfig(): Promise<void> {
    this.authorizedLocalConfig = await this.hostGit(["config", "--local", "--null", "--list"]);
  }

  // Fail closed if the repo-local git config drifted from the clone-time
  // capture. Any agent-added key (filter.*.clean, core.fsmonitor,
  // core.hooksPath, textconv, ...) can turn a later host `add`/`diff` into
  // host code execution, so this must run before any host working-tree op.
  // `git config --list` itself executes nothing.
  private async assertAuthorizedRepoConfig(): Promise<void> {
    if (this.authorizedLocalConfig === undefined) {
      throw new Error("repository config was not captured before inspection");
    }
    const current = await this.hostGit(["config", "--local", "--null", "--list"]);
    if (current !== this.authorizedLocalConfig) {
      throw new Error("repository Git configuration changed after authorization");
    }
  }

  private async hostGit(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.hostWorkspace,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...extraEnv,
      },
      maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
      encoding: "utf8",
    });
    return stdout;
  }
}
