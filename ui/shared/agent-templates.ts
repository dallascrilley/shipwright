import type {
  ActionPreset,
  AgentDraft,
  GithubTriggerChoiceId,
  GithubTriggerConfig,
} from "./agent-definition";
import {
  GITHUB_TRIGGER_CHOICES,
  defaultSkillIdForActionPreset,
} from "./agent-definition";

export const AGENT_TEMPLATE_IDS = [
  "issue_opened_fix_issue",
  "pr_opened_resolve_feedback",
  "issue_edited_fix_issue",
  "pr_synchronize_resolve_feedback",
] as const;

export type AgentTemplateId = (typeof AGENT_TEMPLATE_IDS)[number];

export interface AgentTemplate {
  id: AgentTemplateId;
  label: string;
  description: string;
  actionPreset: ActionPreset;
  skillId: string;
  githubTriggerChoiceId: GithubTriggerChoiceId;
  nameStub: string;
  instructionsStub: string;
  publicationPolicy: "dry_run";
  allowedTools: readonly string[];
  verificationPresetId: string;
  cancelInFlight: boolean;
}

export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: "issue_opened_fix_issue",
    label: "Issue opened → Fix issue",
    description:
      "Investigate newly opened issues, implement a fix, and prepare a dry-run publication.",
    actionPreset: "fix_issue",
    skillId: "",
    githubTriggerChoiceId: "issue_created",
    nameStub: "Fix issue on open",
    instructionsStub:
      "When a new issue is opened in the watched repository, investigate the report, implement a fix in a sandbox, run verification, and prepare a dry-run publication.",
    publicationPolicy: "dry_run",
    allowedTools: ["github", "terminal"],
    verificationPresetId: "bun-test",
    cancelInFlight: true,
  },
  {
    id: "pr_opened_resolve_feedback",
    label: "PR opened → Resolve PR feedback",
    description:
      "Review newly opened pull requests, address feedback, and prepare a dry-run publication.",
    actionPreset: "resolve_pr_feedback",
    skillId: "fix-review-findings",
    githubTriggerChoiceId: "pull_request_created",
    nameStub: "Resolve PR feedback on open",
    instructionsStub:
      "When a pull request is opened, review outstanding feedback, address findings in a sandbox, run verification, and prepare a dry-run publication.",
    publicationPolicy: "dry_run",
    allowedTools: ["github", "terminal"],
    verificationPresetId: "bun-test",
    cancelInFlight: true,
  },
  {
    id: "issue_edited_fix_issue",
    label: "Issue edited → Fix issue",
    description:
      "Re-evaluate edited issues, implement updates, and prepare a dry-run publication.",
    actionPreset: "fix_issue",
    skillId: "",
    githubTriggerChoiceId: "issue_edited",
    nameStub: "Fix issue on edit",
    instructionsStub:
      "When an issue is edited in the watched repository, re-evaluate the latest details, implement any needed fix in a sandbox, run verification, and prepare a dry-run publication.",
    publicationPolicy: "dry_run",
    allowedTools: ["github", "terminal"],
    verificationPresetId: "bun-test",
    cancelInFlight: true,
  },
  {
    id: "pr_synchronize_resolve_feedback",
    label: "PR updated → Resolve PR feedback",
    description:
      "Respond to new commits on pull requests and prepare a dry-run publication.",
    actionPreset: "resolve_pr_feedback",
    skillId: "fix-review-findings",
    githubTriggerChoiceId: "pull_request_pushed",
    nameStub: "Resolve PR feedback on push",
    instructionsStub:
      "When new commits are pushed to a pull request, review outstanding feedback against the updated head, address findings in a sandbox, run verification, and prepare a dry-run publication.",
    publicationPolicy: "dry_run",
    allowedTools: ["github", "terminal"],
    verificationPresetId: "bun-test",
    cancelInFlight: true,
  },
] as const;

const templateById = new Map(
  AGENT_TEMPLATES.map((template) => [template.id, template]),
);

export function listAgentTemplates(): readonly AgentTemplate[] {
  return AGENT_TEMPLATES;
}

export function findAgentTemplate(
  templateId: string,
): AgentTemplate | undefined {
  return templateById.get(templateId as AgentTemplateId);
}

export function buildDraftFromTemplate(
  templateId: AgentTemplateId,
  repository: string,
): AgentDraft {
  const template = findAgentTemplate(templateId);
  if (!template) {
    throw new Error(`Unknown agent template "${templateId}".`);
  }

  const skillId =
    template.skillId || defaultSkillIdForActionPreset(template.actionPreset);

  return {
    name: template.nameStub,
    instructions: template.instructionsStub,
    actionPreset: template.actionPreset,
    skillId,
    allowedTools: [...template.allowedTools],
    targetScope: {
      repository,
      branch: "main",
    },
    verification: { presetId: template.verificationPresetId },
    publicationPolicy: template.publicationPolicy,
    cancelInFlight: template.cancelInFlight,
  };
}

export function buildTriggerConfigFromTemplate(
  templateId: AgentTemplateId,
): GithubTriggerConfig {
  const template = findAgentTemplate(templateId);
  if (!template) {
    throw new Error(`Unknown agent template "${templateId}".`);
  }

  const choice = GITHUB_TRIGGER_CHOICES.find(
    (item) => item.id === template.githubTriggerChoiceId,
  );
  if (!choice) {
    throw new Error(
      `Template "${templateId}" references unknown GitHub trigger choice "${template.githubTriggerChoiceId}".`,
    );
  }

  return {
    event: choice.event,
    actions: [choice.action],
    conditions: [],
  };
}
