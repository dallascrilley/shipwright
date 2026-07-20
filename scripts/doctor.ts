import { accessSync, constants, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { parseGitHubConfig } from "../src/config/github.js";
import { resolveProvider } from "../src/config/provider.js";
import { resolveSandboxImage } from "../src/sandbox/runtime.js";

interface Check {
  name: string;
  detail: string;
  passed: boolean;
}

function commandCheck(
  name: string,
  command: string,
  args: string[] = [],
  options: { cwd?: string; minimumMajor?: number } = {},
): Check {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
  const version = result.status === 0 ? result.stdout.trim().split("\n")[0] : "unavailable";
  const major = Number.parseInt(version.match(/\d+/)?.[0] ?? "", 10);
  const versionSupported =
    options.minimumMajor === undefined || (Number.isFinite(major) && major >= options.minimumMajor);
  return { name, detail: version, passed: result.status === 0 && versionSupported };
}

function configurationCheck(name: string, validate: () => string): Check {
  try {
    return { name, detail: validate(), passed: true };
  } catch {
    return { name, detail: "not configured", passed: false };
  }
}

const runtimeOnly = process.argv.includes("--runtime-only");
const stateDirectory = resolve(
  process.env.SHIPWRIGHT_STATE_DIR?.trim() || ".artifacts/shipwright",
);
const sandboxImage = resolveSandboxImage(process.env.SHIPWRIGHT_SANDBOX_IMAGE);
mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });

const checks: Check[] = [
  commandCheck("Bun", "bun", ["--version"]),
  commandCheck("Node", "node", ["--version"], { minimumMajor: 22 }),
  commandCheck("pnpm", "pnpm", ["--version"], {
    cwd: resolve("ui"),
    minimumMajor: 10,
  }),
  {
    name: "Docker daemon",
    detail: "reachable",
    passed: spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0,
  },
  {
    name: "Sandbox image",
    detail: sandboxImage,
    passed:
      spawnSync("docker", ["image", "inspect", sandboxImage], {
        stdio: "ignore",
      }).status === 0,
  },
  configurationCheck("State directory", () => {
    accessSync(stateDirectory, constants.R_OK | constants.W_OK | constants.X_OK);
    return stateDirectory;
  }),
];

if (!runtimeOnly) {
  checks.push(
    configurationCheck("GitHub App", () => {
      const config = parseGitHubConfig();
      return `${config.allowedRepositories.size} allowlisted repository`;
    }),
    configurationCheck("Model provider", () => {
      const provider = resolveProvider();
      return `${provider.name}/${provider.model}`;
    }),
  );
}

for (const check of checks) {
  console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
}

if (checks.some((check) => !check.passed)) process.exitCode = 1;
