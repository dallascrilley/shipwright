import { describe, expect, test } from "vitest";

import type { GithubTriggerCondition } from "../shared/agent-definition";
import {
  evaluateGithubTriggerConditions,
  type GitHubTriggerConditionContext,
} from "./github-trigger-conditions";

const context: GitHubTriggerConditionContext = {
  actor: { state: "available", value: "Alice" },
  labels: { state: "available", value: ["Bug", "Urgent"] },
  baseBranch: { state: "available", value: "main" },
  draftState: { state: "available", value: false },
};

describe("evaluateGithubTriggerConditions", () => {
  test("matches all typed operators with their configured comparison semantics", () => {
    const conditions: GithubTriggerCondition[] = [
      { field: "actor", operator: "is_one_of", values: ["alice"] },
      {
        field: "actor",
        operator: "is_not_one_of",
        values: ["dependabot"],
      },
      { field: "labels", operator: "include_any", values: ["urgent"] },
      {
        field: "labels",
        operator: "include_all",
        values: ["bug", "URGENT"],
      },
      {
        field: "labels",
        operator: "include_none",
        values: ["blocked"],
      },
      {
        field: "base_branch",
        operator: "is_one_of",
        values: ["main"],
      },
      {
        field: "base_branch",
        operator: "is_not_one_of",
        values: ["Main"],
      },
      { field: "draft_state", operator: "is_not_draft" },
    ];

    expect(evaluateGithubTriggerConditions(conditions, context)).toEqual({
      matched: true,
      reasonCodes: [],
    });
  });

  test("returns bounded field-specific mismatch reasons without observed values", () => {
    const conditions: GithubTriggerCondition[] = [
      { field: "actor", operator: "is_not_one_of", values: ["ALICE"] },
      { field: "labels", operator: "include_none", values: ["bug"] },
      {
        field: "base_branch",
        operator: "is_one_of",
        values: ["Main"],
      },
      { field: "draft_state", operator: "is_draft" },
    ];

    expect(evaluateGithubTriggerConditions(conditions, context)).toEqual({
      matched: false,
      reasonCodes: [
        "actor_mismatch",
        "labels_mismatch",
        "base_branch_mismatch",
        "draft_state_mismatch",
      ],
    });
  });

  test("fails closed for missing and malformed configured fields", () => {
    const conditions: GithubTriggerCondition[] = [
      { field: "actor", operator: "is_one_of", values: ["alice"] },
      { field: "labels", operator: "include_any", values: ["bug"] },
      {
        field: "base_branch",
        operator: "is_one_of",
        values: ["main"],
      },
      { field: "draft_state", operator: "is_not_draft" },
    ];
    const unavailable: GitHubTriggerConditionContext = {
      actor: { state: "missing" },
      labels: { state: "malformed" },
      baseBranch: { state: "missing" },
      draftState: { state: "malformed" },
    };

    expect(evaluateGithubTriggerConditions(conditions, unavailable)).toEqual({
      matched: false,
      reasonCodes: [
        "actor_missing",
        "labels_malformed",
        "base_branch_missing",
        "draft_state_malformed",
      ],
    });
  });

  test("keeps an unconditional trigger matched", () => {
    expect(evaluateGithubTriggerConditions([], context)).toEqual({
      matched: true,
      reasonCodes: [],
    });
  });
});
