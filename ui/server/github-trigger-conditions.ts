import type { GithubTriggerCondition } from "../shared/agent-definition";

export type GitHubTriggerConditionFieldState<T> =
  | { state: "available"; value: T }
  | { state: "missing" }
  | { state: "malformed" };

export interface GitHubTriggerConditionContext {
  actor: GitHubTriggerConditionFieldState<string>;
  labels: GitHubTriggerConditionFieldState<string[]>;
  baseBranch: GitHubTriggerConditionFieldState<string>;
  draftState: GitHubTriggerConditionFieldState<boolean>;
}

export type GitHubTriggerConditionReasonCode =
  | "actor_missing"
  | "actor_malformed"
  | "actor_mismatch"
  | "labels_missing"
  | "labels_malformed"
  | "labels_mismatch"
  | "base_branch_missing"
  | "base_branch_malformed"
  | "base_branch_mismatch"
  | "draft_state_missing"
  | "draft_state_malformed"
  | "draft_state_mismatch";

export interface GitHubTriggerConditionEvaluation {
  matched: boolean;
  reasonCodes: GitHubTriggerConditionReasonCode[];
}

export function evaluateGithubTriggerConditions(
  conditions: readonly GithubTriggerCondition[],
  context: GitHubTriggerConditionContext,
): GitHubTriggerConditionEvaluation {
  const reasonCodes: GitHubTriggerConditionReasonCode[] = [];
  const addReason = (reason: GitHubTriggerConditionReasonCode) => {
    if (!reasonCodes.includes(reason)) reasonCodes.push(reason);
  };

  for (const condition of conditions) {
    switch (condition.field) {
      case "actor": {
        if (!fieldIsAvailable(context.actor, "actor", addReason)) break;
        const actor = context.actor.value.toLowerCase();
        const included = condition.values.some(
          (value) => value.toLowerCase() === actor,
        );
        if (
          (condition.operator === "is_one_of" && !included) ||
          (condition.operator === "is_not_one_of" && included)
        ) {
          addReason("actor_mismatch");
        }
        break;
      }
      case "labels": {
        if (!fieldIsAvailable(context.labels, "labels", addReason)) break;
        const labels = new Set(
          context.labels.value.map((value) => value.toLowerCase()),
        );
        const configured = condition.values.map((value) => value.toLowerCase());
        const matched =
          condition.operator === "include_any"
            ? configured.some((value) => labels.has(value))
            : condition.operator === "include_all"
              ? configured.every((value) => labels.has(value))
              : configured.every((value) => !labels.has(value));
        if (!matched) addReason("labels_mismatch");
        break;
      }
      case "base_branch": {
        if (!fieldIsAvailable(context.baseBranch, "base_branch", addReason)) {
          break;
        }
        const included = condition.values.includes(context.baseBranch.value);
        if (
          (condition.operator === "is_one_of" && !included) ||
          (condition.operator === "is_not_one_of" && included)
        ) {
          addReason("base_branch_mismatch");
        }
        break;
      }
      case "draft_state": {
        if (!fieldIsAvailable(context.draftState, "draft_state", addReason)) {
          break;
        }
        const matched =
          condition.operator === "is_draft"
            ? context.draftState.value
            : !context.draftState.value;
        if (!matched) addReason("draft_state_mismatch");
        break;
      }
    }
  }

  return { matched: reasonCodes.length === 0, reasonCodes };
}

function fieldIsAvailable<T>(
  field: GitHubTriggerConditionFieldState<T>,
  name: "actor" | "labels" | "base_branch" | "draft_state",
  addReason: (reason: GitHubTriggerConditionReasonCode) => void,
): field is { state: "available"; value: T } {
  if (field.state === "available") return true;
  addReason(`${name}_${field.state}` as GitHubTriggerConditionReasonCode);
  return false;
}
