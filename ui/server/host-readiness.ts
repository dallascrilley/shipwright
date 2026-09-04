import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveShipwrightStateDirectory } from "../../src/config/state.js";
import { resolveProviderChain } from "../../src/config/provider.js";
import {
  buildHostReadinessReport,
  type HostReadinessComponent,
  type HostReadinessReport,
  type HostReadinessStatus,
} from "../shared/host-readiness";
import { isOperatorDemoMode } from "./operator-runs";

/** Redacted presence flags only — never credential values. */
export interface ProviderReadinessInput {
  /** False when non-secret provider selection or thinking configuration is invalid. */
  configurationValid?: boolean;
  hasCredential: boolean;
  /** Non-secret provider identity when known (e.g. "kimi"). */
  providerName?: string;
}

export interface GitHubAppReadinessInput {
  hasAppId: boolean;
  hasInlinePrivateKey: boolean;
  hasPrivateKeyPath: boolean;
  /** True when a configured key path exists and is readable. */
  privateKeyPathReadable?: boolean;
}

export interface DockerReadinessInput {
  socketPath: string;
  exists: boolean;
  readable: boolean;
}

export interface StateStoreReadinessInput {
  path: string;
  exists: boolean;
  readable: boolean;
}

export interface HostReadinessProbeInputs {
  demoMode: boolean;
  checkedAt: string;
  provider: ProviderReadinessInput;
  githubApp: GitHubAppReadinessInput;
  docker: DockerReadinessInput;
  stateStore: StateStoreReadinessInput;
}

export type HostReadinessInputLoader = () => HostReadinessProbeInputs;

function component(
  id: HostReadinessComponent["id"],
  status: HostReadinessStatus,
  code: HostReadinessComponent["code"],
  checkedAt: string,
  detail?: string,
): HostReadinessComponent {
  return {
    id,
    status,
    code,
    checkedAt,
    ...(detail ? { detail } : {}),
  };
}

export function evaluateProviderReadiness(
  input: ProviderReadinessInput,
  checkedAt: string,
): HostReadinessComponent {
  if (!input.hasCredential) {
    return component(
      "provider",
      "not_configured",
      "provider_missing",
      checkedAt,
    );
  }
  if (input.configurationValid === false) {
    return component(
      "provider",
      "unavailable",
      "provider_invalid",
      checkedAt,
      input.providerName,
    );
  }
  return component(
    "provider",
    "ready",
    "provider_configured",
    checkedAt,
    input.providerName,
  );
}

export function evaluateGitHubAppReadiness(
  input: GitHubAppReadinessInput,
  checkedAt: string,
): HostReadinessComponent {
  const keySources =
    Number(input.hasInlinePrivateKey) + Number(input.hasPrivateKeyPath);
  if (!input.hasAppId || keySources !== 1) {
    return component(
      "github_app",
      "not_configured",
      "github_app_missing",
      checkedAt,
    );
  }
  if (input.hasPrivateKeyPath && input.privateKeyPathReadable === false) {
    return component(
      "github_app",
      "unavailable",
      "github_app_key_unreadable",
      checkedAt,
    );
  }
  return component("github_app", "ready", "github_app_configured", checkedAt);
}

export function evaluateDockerReadiness(
  input: DockerReadinessInput,
  checkedAt: string,
): HostReadinessComponent {
  if (!input.exists) {
    return component(
      "docker",
      "not_configured",
      "docker_socket_missing",
      checkedAt,
    );
  }
  if (!input.readable) {
    return component(
      "docker",
      "unavailable",
      "docker_socket_unreadable",
      checkedAt,
    );
  }
  return component("docker", "ready", "docker_socket_ready", checkedAt);
}

export function evaluateStateStoreReadiness(
  input: StateStoreReadinessInput,
  checkedAt: string,
): HostReadinessComponent {
  if (!input.exists) {
    // Missing state dir/file is first-boot not_configured (not a hard outage).
    return component(
      "state_store",
      "not_configured",
      "state_store_missing",
      checkedAt,
    );
  }
  if (!input.readable) {
    return component(
      "state_store",
      "unavailable",
      "state_store_unreadable",
      checkedAt,
    );
  }
  return component("state_store", "ready", "state_store_ready", checkedAt);
}

/**
 * Pure evaluator over already-redacted probe inputs.
 * Never accepts credential-bearing config objects.
 */
export function evaluateHostReadiness(
  inputs: HostReadinessProbeInputs,
): HostReadinessReport {
  const { checkedAt } = inputs;
  const components = [
    evaluateProviderReadiness(inputs.provider, checkedAt),
    evaluateGitHubAppReadiness(inputs.githubApp, checkedAt),
    evaluateDockerReadiness(inputs.docker, checkedAt),
    evaluateStateStoreReadiness(inputs.stateStore, checkedAt),
  ];
  return buildHostReadinessReport({
    demoMode: inputs.demoMode,
    checkedAt,
    components,
  });
}

function envHasNonEmpty(name: string, env: NodeJS.ProcessEnv): boolean {
  return Boolean(env[name]?.trim());
}

function isPathReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** Resolve default docker socket without launching docker or opening a client. */
export function resolveDockerSocketPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dockerHost = env.DOCKER_HOST?.trim();
  if (dockerHost?.startsWith("unix://")) {
    return dockerHost.slice("unix://".length);
  }
  // Common Docker Desktop / Linux defaults. Presence-only.
  const desktop = join(homedir(), ".docker/run/docker.sock");
  if (pathExists(desktop)) return desktop;
  return "/var/run/docker.sock";
}

/**
 * Collect redacted presence/handle inputs from the host environment.
 * Values of secrets are never returned — only booleans and non-secret names.
 */
export function loadHostReadinessProbeInputs(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    now?: () => string;
    stateDirectory?: string;
    dockerSocketPath?: string;
  } = {},
): HostReadinessProbeInputs {
  const checkedAt = (options.now ?? (() => new Date().toISOString()))();
  const demoMode = env.SHIPWRIGHT_UI_DEMO === "1" || isOperatorDemoMode();

  const providerFlags = {
    anthropic: envHasNonEmpty("ANTHROPIC_API_KEY", env),
    openrouter: envHasNonEmpty("OPENROUTER_API_KEY", env),
    openai: envHasNonEmpty("OPENAI_API_KEY", env),
    "openai-codex": envHasNonEmpty("AGENTOS_CODEX_AUTH_FILE", env),
    google: envHasNonEmpty("GEMINI_API_KEY", env),
    kimi: envHasNonEmpty("KIMI_API_KEY", env),
  } as const;
  const requested = env.AGENTOS_PROVIDER?.trim();
  const hasCredential = requested
    ? Boolean(providerFlags[requested as keyof typeof providerFlags])
    : Object.values(providerFlags).some(Boolean);
  let providerName = requested
    ? hasCredential
      ? requested
      : undefined
    : (Object.entries(providerFlags).find(([, present]) => present)?.[0] as
        | string
        | undefined);
  let configurationValid = true;
  if (hasCredential) {
    try {
      providerName = resolveProviderChain(env)[0]?.name ?? providerName;
    } catch {
      configurationValid = false;
    }
  }

  const hasInlinePrivateKey = envHasNonEmpty("GITHUB_APP_PRIVATE_KEY", env);
  const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim() ?? "";
  const hasPrivateKeyPath = Boolean(keyPath);
  const privateKeyPathReadable =
    hasPrivateKeyPath && keyPath ? isPathReadable(keyPath) : undefined;

  const socketPath = options.dockerSocketPath ?? resolveDockerSocketPath(env);
  const socketExists = pathExists(socketPath);
  const socketReadable = socketExists ? isPathReadable(socketPath) : false;

  const stateDirectory =
    options.stateDirectory ?? resolveShipwrightStateDirectory();
  // Registry JSON store path — presence/readability only; never open via registry
  // or parse contents.
  const stateStorePath = join(stateDirectory, "operator-runs.json");
  const directoryExists = pathExists(stateDirectory);
  const fileExists = pathExists(stateStorePath);
  let stateReadable = false;
  if (fileExists) {
    stateReadable = isPathReadable(stateStorePath);
  } else if (directoryExists) {
    // Empty first-boot dir is readable when the directory itself is.
    try {
      accessSync(stateDirectory, constants.R_OK);
      stateReadable = statSync(stateDirectory).isDirectory();
    } catch {
      stateReadable = false;
    }
  }

  return {
    demoMode,
    checkedAt,
    provider: {
      configurationValid,
      hasCredential,
      ...(providerName ? { providerName } : {}),
    },
    githubApp: {
      hasAppId: envHasNonEmpty("GITHUB_APP_ID", env),
      hasInlinePrivateKey,
      hasPrivateKeyPath,
      ...(privateKeyPathReadable !== undefined
        ? { privateKeyPathReadable }
        : {}),
    },
    docker: {
      socketPath,
      exists: socketExists,
      readable: socketReadable,
    },
    stateStore: {
      path: stateStorePath,
      exists: fileExists || directoryExists,
      readable: stateReadable,
    },
  };
}

export function getHostReadiness(
  loadInputs: HostReadinessInputLoader = loadHostReadinessProbeInputs,
): HostReadinessReport {
  return evaluateHostReadiness(loadInputs());
}
