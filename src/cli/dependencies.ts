import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAndRunPiAgent } from "../agent/runner.js";
import { parseGitHubConfig } from "../config/github.js";
import {
  isProviderCapacityError,
  resolveProviderChain,
  type ProviderConfig,
} from "../config/provider.js";
import { resolveShipwrightStateDirectory } from "../config/state.js";
import { authorizeIssue, authorizePullRequest, createOctokitTransport } from "../github/app-client.js";
import { openOrReusePullRequest } from "../github/publisher.js";
import type { RunReceipt } from "../pipeline/receipt.js";
import { defaultReceiptWriter, type PipelineDependencies } from "../pipeline/run.js";
import { defaultReviewReceiptWriter, type ReviewPipelineDependencies } from "../pipeline/review-run.js";
import type { ReviewRunReceipt } from "../pipeline/review-receipt.js";
import type { AgentExecution } from "../pipeline/receipt.js";
import { SandboxWorkspace } from "../sandbox/runtime.js";

export interface PipelineDependencyOptions {
  signal?: AbortSignal;
  runId?: string;
  onProgress?: (receipt: RunReceipt) => void | Promise<void>;
}

export interface ReviewPipelineDependencyOptions {
  signal?: AbortSignal;
  runId?: string;
  onProgress?: (receipt: ReviewRunReceipt) => void | Promise<void>;
}

function isProviderCapacityResponse(response: string): boolean {
  const trimmed = response.trim();
  const hasProviderErrorShape =
    /^(?:HTTP\s+)?(?:402|403|408|429|502|503)\b/i.test(trimmed) ||
    /^\{[\s\S]*["']error["']\s*:/i.test(trimmed);
  return hasProviderErrorShape && isProviderCapacityError(trimmed);
}

export async function runWithProviderFallback<T>(
  providers: ProviderConfig[],
  execution: AgentExecution,
  run: (provider: ProviderConfig) => Promise<T>,
): Promise<T> {
  execution.attempts = [];
  execution.fallbackUsed = false;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index]!;
    execution.provider = provider.name;
    execution.model = provider.model;
    execution.fallbackUsed = index > 0;
    try {
      const result = await run(provider);
      if (typeof result === "string" && isProviderCapacityResponse(result)) {
        throw new Error(result);
      }
      execution.attempts.push({
        provider: provider.name,
        model: provider.model,
        outcome: "succeeded",
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const capacityFailure = isProviderCapacityError(message);
      execution.attempts.push({
        provider: provider.name,
        model: provider.model,
        outcome: capacityFailure ? "capacity_failed" : "failed",
      });
      if (!capacityFailure) throw error;
      if (index === providers.length - 1) {
        if (providers.length === 1) throw error;
        throw new Error(
          `provider fallback capacity exhausted after ${providers.length} attempts`,
          { cause: error },
        );
      }
    }
  }
  throw new Error("provider fallback chain is empty");
}

function agentExecution(providers: ProviderConfig[]): AgentExecution {
  const primary = providers[0]!;
  return {
    runtime: "agentos",
    software: "pi",
    provider: primary.name,
    model: primary.model,
    fallbackUsed: false,
    attempts: [],
  };
}

export function createReviewPipelineDependencies(
  skillPath: string,
  options: ReviewPipelineDependencyOptions = {},
): ReviewPipelineDependencies {
  const githubConfig = parseGitHubConfig();
  const providers = resolveProviderChain();
  const execution = agentExecution(providers);
  const transport = createOctokitTransport(githubConfig);
  const content = readFileSync(skillPath, "utf8");
  if (!/^---[\s\S]*?^name:\s*["']?fix-review-findings["']?\s*$/m.test(content)) {
    throw new Error("--skill must point to the fix-review-findings SKILL.md");
  }
  const skill = {
    name: "fix-review-findings" as const,
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  return {
    execution,
    skill,
    authorize: (ref) => authorizePullRequest(ref, githubConfig, transport),
    createWorkspace: () => SandboxWorkspace.start(),
    runAgent: (workspace, prompt, timeoutMs, skills) => runWithProviderFallback(
      providers,
      execution,
      (provider) => createAndRunPiAgent(
        workspace as SandboxWorkspace,
        provider,
        prompt,
        timeoutMs,
        skills,
      ),
    ),
    writeReceipt: defaultReviewReceiptWriter,
    artifactRoot: join(resolveShipwrightStateDirectory(), "review-receipts"),
    ...options,
  };
}

export function createPipelineDependencies(
  options: PipelineDependencyOptions = {},
): PipelineDependencies {
  const githubConfig = parseGitHubConfig();
  const providers = resolveProviderChain();
  const execution = agentExecution(providers);
  const transport = createOctokitTransport(githubConfig);

  return {
    execution,
    authorize: (ref) => authorizeIssue(ref, githubConfig, transport),
    createWorkspace: () => SandboxWorkspace.start(),
    runAgent: (workspace, prompt, timeoutMs) => runWithProviderFallback(
      providers,
      execution,
      (provider) => createAndRunPiAgent(
        workspace as SandboxWorkspace,
        provider,
        prompt,
        timeoutMs,
      ),
    ),
    openPullRequest: (authorized, input) =>
      openOrReusePullRequest(authorized.repositoryClient, input),
    writeReceipt: defaultReceiptWriter,
    artifactRoot: join(resolveShipwrightStateDirectory(), "receipts"),
    ...options,
  };
}
