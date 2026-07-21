import { targetMatchesScope } from "../shared/agent-definition";

import type { OperatorStoredRequest } from "../shared/operator-run";
import type { QueueRunner } from "./queue-dispatcher";
import { executeOperatorPipeline } from "./operator-runs";
import { resolveVerifyPreset } from "./verify-presets";

/**
 * Bridges a pinned control-plane revision to the existing host-owned pipeline.
 * Credentials remain inside the existing pipeline dependencies; only the immutable
 * target, verification preset, and publication policy cross the queue boundary.
 */
export const operatorPipelineQueueRunner: QueueRunner = async (context) => {
  const { target } = context.execution;
  if (!targetMatchesScope(target, context.revision.draft.targetScope)) {
    return {
      receipt: {
        runId: context.execution.executionId,
        phase: "policy",
        verificationPassed: false,
        errorCode: "target_scope_violation",
      },
    };
  }

  const isReview = target.kind === "pull";
  const url = `https://github.com/${target.owner}/${target.repo}/${
    isReview ? "pull" : "issues"
  }/${target.number}`;
  const preset = resolveVerifyPreset(context.revision.draft.verification.presetId);
  const request: OperatorStoredRequest = {
    mode: isReview ? "review" : "issue",
    issueUrl: isReview ? "" : url,
    pullRequestUrl: isReview ? url : "",
    skillId: isReview ? context.revision.draft.skillId : "",
    presetId: preset.id,
    verifyCommand: preset.command,
    publish: context.revision.draft.publicationPolicy === "publish_allowed",
    timeoutMinutes: 30,
  };
  try {
    const receipt = await executeOperatorPipeline(
      request,
      context.execution.executionId,
      () => undefined,
      context.signal,
    );
    return {
      receipt: {
        runId: receipt.runId,
        phase: receipt.phase,
        verificationPassed: receipt.verification.passed,
        ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
      },
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[a-z][a-z0-9_]*$/.test(error.code)
        ? error.code
        : "runner_failed";
    return {
      receipt: {
        runId: context.execution.executionId,
        phase: "failed",
        verificationPassed: false,
        errorCode,
      },
    };
  }
};
