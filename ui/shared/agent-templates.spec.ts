import { describe, expect, test } from "vitest";

import {
  AGENT_TEMPLATES,
  buildDraftFromTemplate,
  buildTriggerConfigFromTemplate,
  findAgentTemplate,
  listAgentTemplates,
} from "./agent-templates";
import {
  agentDraftSchema,
  curatedGithubTriggerConfigSchema,
  findGithubTriggerChoice,
  validateActionPresetAgainstAgentTriggers,
  validateActionPresetGithubTriggerConsistency,
} from "./agent-definition";

describe("agent templates", () => {
  test("lists the curated template catalog", () => {
    expect(listAgentTemplates()).toEqual(AGENT_TEMPLATES);
    expect(AGENT_TEMPLATES.map((template) => template.id)).toEqual([
      "issue_opened_fix_issue",
      "pr_opened_resolve_feedback",
      "issue_edited_fix_issue",
      "pr_synchronize_resolve_feedback",
    ]);
  });

  test.each([
    [
      "issue_opened_fix_issue",
      {
        actionPreset: "fix_issue",
        skillId: "",
        publicationPolicy: "dry_run",
        githubTriggerChoiceId: "issue_created",
      },
    ],
    [
      "pr_opened_resolve_feedback",
      {
        actionPreset: "resolve_pr_feedback",
        skillId: "fix-review-findings",
        publicationPolicy: "dry_run",
        githubTriggerChoiceId: "pull_request_created",
      },
    ],
    [
      "issue_edited_fix_issue",
      {
        actionPreset: "fix_issue",
        skillId: "",
        publicationPolicy: "dry_run",
        githubTriggerChoiceId: "issue_edited",
      },
    ],
    [
      "pr_synchronize_resolve_feedback",
      {
        actionPreset: "resolve_pr_feedback",
        skillId: "fix-review-findings",
        publicationPolicy: "dry_run",
        githubTriggerChoiceId: "pull_request_pushed",
      },
    ],
  ] as const)(
    "buildDraftFromTemplate(%s) prefills the expected draft shape",
    (templateId, expected) => {
      const template = findAgentTemplate(templateId);
      expect(template).toBeDefined();

      const draft = buildDraftFromTemplate(templateId, "acme/widget");
      expect(agentDraftSchema.parse(draft)).toEqual(draft);
      expect(draft.actionPreset).toBe(expected.actionPreset);
      expect(draft.skillId).toBe(expected.skillId);
      expect(draft.publicationPolicy).toBe(expected.publicationPolicy);
      expect(draft.targetScope.repository).toBe("acme/widget");
      expect(draft.name).toBe(template?.nameStub);
      expect(draft.instructions).toBe(template?.instructionsStub);
      expect(draft.allowedTools.length).toBeGreaterThan(0);

      const triggerConfig = buildTriggerConfigFromTemplate(templateId);
      expect(curatedGithubTriggerConfigSchema.parse(triggerConfig)).toEqual(
        triggerConfig,
      );
      expect(findGithubTriggerChoice(triggerConfig)?.id).toBe(
        expected.githubTriggerChoiceId,
      );
      expect(
        validateActionPresetGithubTriggerConsistency(
          draft.actionPreset,
          triggerConfig,
        ),
      ).toBeUndefined();
      expect(
        validateActionPresetAgainstAgentTriggers(draft.actionPreset, [
          { kind: "github", config: triggerConfig },
        ]),
      ).toBeUndefined();
    },
  );

  test("templates stay dry-run and never imply auto-enable", () => {
    for (const template of AGENT_TEMPLATES) {
      const draft = buildDraftFromTemplate(template.id, "acme/widget");
      expect(draft.publicationPolicy).toBe("dry_run");
      expect(draft.publicationPolicy).not.toBe("publish_allowed");
    }
  });

  test("buildTriggerConfigFromTemplate maps curated GitHub choices with empty conditions", () => {
    expect(buildTriggerConfigFromTemplate("issue_opened_fix_issue")).toEqual({
      event: "issues",
      actions: ["opened"],
      conditions: [],
    });
    expect(buildTriggerConfigFromTemplate("issue_edited_fix_issue")).toEqual({
      event: "issues",
      actions: ["edited"],
      conditions: [],
    });
    expect(
      buildTriggerConfigFromTemplate("pr_opened_resolve_feedback"),
    ).toEqual({
      event: "pull_request",
      actions: ["opened"],
      conditions: [],
    });
    expect(
      buildTriggerConfigFromTemplate("pr_synchronize_resolve_feedback"),
    ).toEqual({
      event: "pull_request",
      actions: ["synchronize"],
      conditions: [],
    });
  });

  test("rejects unknown template ids", () => {
    expect(() =>
      buildDraftFromTemplate("missing" as "issue_opened_fix_issue", "acme/widget"),
    ).toThrow(/Unknown agent template/);
    expect(() =>
      buildTriggerConfigFromTemplate("missing" as "issue_opened_fix_issue"),
    ).toThrow(/Unknown agent template/);
  });
});
