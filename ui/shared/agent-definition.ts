import { z } from "zod";

import { containsSecretLikeContent } from "../../src/pipeline/secret-safety";
import { validateSchedule } from "./schedule";

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Use an identifier-safe value.")
  .refine(
    (value) => !containsSecretLikeContent(value),
    "Secret-like values cannot be stored in agent configuration.",
  );

function safeText(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine(
      (value) => !containsSecretLikeContent(value),
      "Secret-like values cannot be stored in agent configuration.",
    );
}

const timestampSchema = z.string().datetime({ offset: true });
const agentIdSchema = identifierSchema.brand<"AgentId">();
const revisionSchema = z.number().int().positive();
const repositorySchema = z
  .string()
  .trim()
  .regex(/^[^/\s]+\/[^/\s]+$/, "Use owner/repository.")
  .max(300)
  .refine(
    (value) => !containsSecretLikeContent(value),
    "Secret-like values cannot be stored in agent configuration.",
  );

export const publicationPolicySchema = z.enum([
  "dry_run",
  "approval_required",
  "publish_allowed",
]);

export const ACTION_PRESET_CHOICES = [
  { id: "fix_issue", label: "Fix issue" },
  { id: "resolve_pr_feedback", label: "Resolve PR feedback" },
] as const;

export type ActionPreset = (typeof ACTION_PRESET_CHOICES)[number]["id"];

export const actionPresetSchema = z.enum(["fix_issue", "resolve_pr_feedback"]);

const skillIdSchema = z.union([z.literal(""), identifierSchema]);

export function defaultSkillIdForActionPreset(preset: ActionPreset): string {
  return preset === "resolve_pr_feedback" ? "fix-review-findings" : "";
}

export function defaultTargetKindForActionPreset(
  preset: ActionPreset,
): "issue" | "pull" {
  return preset === "fix_issue" ? "issue" : "pull";
}

export function inferActionPresetFromLegacyDraft(
  input: Record<string, unknown>,
  triggers?: readonly { kind: string; config?: unknown }[],
): ActionPreset {
  const skillId = typeof input.skillId === "string" ? input.skillId.trim() : "";
  const githubTriggers =
    triggers?.filter((trigger) => trigger.kind === "github") ?? [];
  const scheduleTriggers =
    triggers?.filter((trigger) => trigger.kind === "schedule") ?? [];

  if (githubTriggers.length > 0) {
    let hasIssues = false;
    let hasPullRequest = false;
    for (const trigger of githubTriggers) {
      const config = trigger.config;
      if (!config || typeof config !== "object") continue;
      const event = (config as { event?: unknown }).event;
      if (event === "issues") hasIssues = true;
      if (event === "pull_request" || event === "pull_request_review") {
        hasPullRequest = true;
      }
    }
    if (hasIssues && !hasPullRequest) return "fix_issue";
    if (hasPullRequest && !hasIssues) return "resolve_pr_feedback";
  }

  if (scheduleTriggers.length > 0) {
    let hasIssueTarget = false;
    let hasPullTarget = false;
    for (const trigger of scheduleTriggers) {
      const config = trigger.config;
      if (!config || typeof config !== "object") continue;
      const target = (config as { target?: { kind?: unknown } }).target;
      if (!target || typeof target !== "object") continue;
      if (target.kind === "issue") hasIssueTarget = true;
      if (target.kind === "pull") hasPullTarget = true;
    }
    if (hasIssueTarget && !hasPullTarget) return "fix_issue";
    if (hasPullTarget && !hasIssueTarget) return "resolve_pr_feedback";
  }

  if (skillId === "fix-review-findings") return "resolve_pr_feedback";
  return "fix_issue";
}

const agentDraftObjectSchema = z
  .object({
    name: safeText(120),
    instructions: safeText(12_000),
    skillId: skillIdSchema,
    actionPreset: actionPresetSchema,
    allowedTools: z.array(identifierSchema).min(1).max(32),
    targetScope: z
      .object({
        repository: repositorySchema,
        branch: safeText(200).optional(),
      })
      .strict(),
    verification: z
      .object({
        presetId: identifierSchema,
      })
      .strict(),
    publicationPolicy: publicationPolicySchema,
    failureThreshold: z.number().int().min(1).max(100).optional(),
    cancelInFlight: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actionPreset === "resolve_pr_feedback" && !value.skillId) {
      context.addIssue({
        code: "custom",
        path: ["skillId"],
        message: "Resolve PR feedback requires a review skillId.",
      });
    }
  });

export const agentDraftSchema = z.preprocess((input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const record = { ...(input as Record<string, unknown>) };
  if (record.actionPreset === undefined) {
    record.actionPreset = inferActionPresetFromLegacyDraft(record);
  }
  return record;
}, agentDraftObjectSchema);

export type AgentDraft = z.output<typeof agentDraftSchema>;
/** Pre-parse draft shape. Uses the object schema because z.preprocess input is unknown. */
export type AgentDraftInput = z.input<typeof agentDraftObjectSchema>;

export const agentHealthSchema = z
  .object({
    state: z.enum(["idle", "queued", "running", "paused", "failed"]),
    lastExecutionAt: timestampSchema.optional(),
    lastOutcome: z.enum(["succeeded", "failed", "cancelled"]).optional(),
    consecutiveScheduleFailures: z.number().int().nonnegative().optional(),
  })
  .strict();

export const agentDefinitionSchema = z
  .object({
    agentId: agentIdSchema,
    currentRevision: revisionSchema,
    enabled: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    health: agentHealthSchema,
  })
  .strict();

export type AgentDefinition = z.output<typeof agentDefinitionSchema>;

export const agentRevisionSchema = z
  .object({
    agentId: agentIdSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
    draft: agentDraftSchema,
  })
  .strict();

export type AgentRevision = z.output<typeof agentRevisionSchema>;

export type GithubTriggerEvent =
  | "issues"
  | "pull_request"
  | "pull_request_review";

export const GITHUB_TRIGGER_CHOICES = [
  {
    id: "issue_created",
    label: "Issue created",
    event: "issues",
    action: "opened",
  },
  {
    id: "issue_edited",
    label: "Issue edited",
    event: "issues",
    action: "edited",
  },
  {
    id: "pull_request_created",
    label: "Pull request created",
    event: "pull_request",
    action: "opened",
  },
  {
    id: "pull_request_pushed",
    label: "Commits pushed to pull request",
    event: "pull_request",
    action: "synchronize",
  },
  {
    id: "pull_request_review_submitted",
    label: "Pull request review submitted",
    event: "pull_request_review",
    action: "submitted",
  },
] as const;

export type GithubTriggerChoice = (typeof GITHUB_TRIGGER_CHOICES)[number];
export type GithubTriggerChoiceId = GithubTriggerChoice["id"];

export const GITHUB_TRIGGER_CONDITION_LIMITS = {
  rows: 10,
  values: 25,
  valueLength: 100,
} as const;

const githubTriggerConditionValueSchema = safeText(
  GITHUB_TRIGGER_CONDITION_LIMITS.valueLength,
);

function membershipValuesSchema(caseInsensitive: boolean) {
  return z
    .array(githubTriggerConditionValueSchema)
    .min(1)
    .max(GITHUB_TRIGGER_CONDITION_LIMITS.values)
    .transform((values) => {
      const seen = new Set<string>();
      return values.filter((value) => {
        const key = caseInsensitive ? value.toLowerCase() : value;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
}

const actorConditionSchema = z
  .object({
    field: z.literal("actor"),
    operator: z.enum(["is_one_of", "is_not_one_of"]),
    values: membershipValuesSchema(true),
  })
  .strict();

const labelsConditionSchema = z
  .object({
    field: z.literal("labels"),
    operator: z.enum(["include_any", "include_all", "include_none"]),
    values: membershipValuesSchema(true),
  })
  .strict();

const baseBranchConditionSchema = z
  .object({
    field: z.literal("base_branch"),
    operator: z.enum(["is_one_of", "is_not_one_of"]),
    values: membershipValuesSchema(false),
  })
  .strict();

const draftStateConditionSchema = z
  .object({
    field: z.literal("draft_state"),
    operator: z.enum(["is_draft", "is_not_draft"]),
  })
  .strict();

export const githubTriggerConditionSchema = z.discriminatedUnion("field", [
  actorConditionSchema,
  labelsConditionSchema,
  baseBranchConditionSchema,
  draftStateConditionSchema,
]);

export type GithubTriggerCondition = z.output<
  typeof githubTriggerConditionSchema
>;
export type GithubTriggerConditionInput = z.input<
  typeof githubTriggerConditionSchema
>;

export const GITHUB_TRIGGER_CONDITION_CATALOG = [
  {
    field: "actor",
    label: "Event actor",
    events: ["issues", "pull_request", "pull_request_review"],
    operators: [
      { id: "is_one_of", label: "is one of" },
      { id: "is_not_one_of", label: "is not one of" },
    ],
  },
  {
    field: "labels",
    label: "Labels",
    events: ["issues", "pull_request", "pull_request_review"],
    operators: [
      { id: "include_any", label: "include any" },
      { id: "include_all", label: "include all" },
      { id: "include_none", label: "include none" },
    ],
  },
  {
    field: "base_branch",
    label: "Base branch",
    events: ["pull_request", "pull_request_review"],
    operators: [
      { id: "is_one_of", label: "is one of" },
      { id: "is_not_one_of", label: "is not one of" },
    ],
  },
  {
    field: "draft_state",
    label: "Draft state",
    events: ["pull_request", "pull_request_review"],
    operators: [
      { id: "is_draft", label: "is draft" },
      { id: "is_not_draft", label: "is not draft" },
    ],
  },
] as const;

export type GithubTriggerConditionField =
  (typeof GITHUB_TRIGGER_CONDITION_CATALOG)[number]["field"];

export const githubTriggerConfigSchema = z
  .object({
    event: z.enum(["issues", "pull_request", "pull_request_review"]),
    actions: z.array(identifierSchema).min(1).max(16),
    conditions: z
      .array(githubTriggerConditionSchema)
      .max(GITHUB_TRIGGER_CONDITION_LIMITS.rows)
      .optional(),
  })
  .strict();

export type GithubTriggerConfig = z.output<typeof githubTriggerConfigSchema>;

export function findGithubTriggerChoice(
  config: GithubTriggerConfig,
): GithubTriggerChoice | undefined {
  if (config.actions.length !== 1) return undefined;
  return GITHUB_TRIGGER_CHOICES.find(
    (choice) =>
      choice.event === config.event && choice.action === config.actions[0],
  );
}

export function githubEventAllowedForActionPreset(
  preset: ActionPreset,
  event: GithubTriggerEvent,
): boolean {
  return preset === "fix_issue"
    ? event === "issues"
    : event === "pull_request" || event === "pull_request_review";
}

export function githubTriggerConfigAllowedForActionPreset(
  preset: ActionPreset,
  config: GithubTriggerConfig,
): boolean {
  return githubEventAllowedForActionPreset(preset, config.event);
}

export function validateActionPresetGithubTriggerConsistency(
  preset: ActionPreset,
  config: GithubTriggerConfig,
): string | undefined {
  if (githubTriggerConfigAllowedForActionPreset(preset, config)) {
    return undefined;
  }
  const choice = findGithubTriggerChoice(config);
  const triggerLabel =
    choice?.label ?? `${config.event}.${config.actions.join("/")}`;
  const expected =
    preset === "fix_issue"
      ? "issue triggers (created or edited)"
      : "pull request triggers (opened, synchronize, or review submitted)";
  return `Action preset "${preset}" cannot use ${triggerLabel}. Use ${expected}.`;
}

export function scheduleTargetAllowedForActionPreset(
  preset: ActionPreset,
  targetKind: "issue" | "pull",
): boolean {
  return preset === "fix_issue"
    ? targetKind === "issue"
    : targetKind === "pull";
}

export function validateActionPresetScheduleTriggerConsistency(
  preset: ActionPreset,
  config: { target: { kind: "issue" | "pull" } },
): string | undefined {
  if (scheduleTargetAllowedForActionPreset(preset, config.target.kind)) {
    return undefined;
  }
  const expected =
    preset === "fix_issue" ? "issue targets" : "pull request targets";
  return `Action preset "${preset}" cannot use schedule target kind "${config.target.kind}". Use ${expected}.`;
}

export function validateActionPresetAgainstAgentTriggers(
  preset: ActionPreset,
  triggers: readonly Pick<AgentTrigger, "kind" | "config">[],
): string | undefined {
  for (const trigger of triggers) {
    if (trigger.kind === "github") {
      const message = validateActionPresetGithubTriggerConsistency(
        preset,
        trigger.config as GithubTriggerConfig,
      );
      if (message) return message;
      continue;
    }
    if (trigger.kind === "schedule" && "target" in trigger.config) {
      const message = validateActionPresetScheduleTriggerConsistency(
        preset,
        trigger.config as { target: { kind: "issue" | "pull" } },
      );
      if (message) return message;
    }
  }
  return undefined;
}

export const curatedGithubTriggerConfigSchema =
  githubTriggerConfigSchema.superRefine((config, context) => {
    if (findGithubTriggerChoice(config) === undefined) {
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "Choose one supported GitHub trigger action.",
      });
    }
    if (config.event === "issues") {
      for (const [index, condition] of (config.conditions ?? []).entries()) {
        if (
          condition.field === "base_branch" ||
          condition.field === "draft_state"
        ) {
          context.addIssue({
            code: "custom",
            path: ["conditions", index, "field"],
            message: `${condition.field} is only available for pull request triggers.`,
          });
        }
      }
    }
  });

export const scheduleTriggerConfigSchema = z
  .object({
    schedule: safeText(200),
    timezone: safeText(100),
    target: z
      .object({
        kind: z.enum(["issue", "pull"]),
        number: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      validateSchedule(value.schedule, value.timezone);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["schedule"],
        message: error instanceof Error ? error.message : "Invalid schedule.",
      });
    }
  });

export const agentTriggerSchema = z
  .object({
    triggerId: identifierSchema,
    agentId: agentIdSchema,
    agentRevision: revisionSchema,
    kind: z.enum(["github", "schedule"]),
    enabled: z.boolean(),
    config: z.union([githubTriggerConfigSchema, scheduleTriggerConfigSchema]),
    nextFireAt: timestampSchema.optional(),
    pausedAt: timestampSchema.optional(),
    consecutiveFailures: z.number().int().nonnegative().optional(),
    lastOutcomeExecutionId: identifierSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "github" && !("event" in value.config)) {
      context.addIssue({
        code: "custom",
        path: ["config"],
        message: "GitHub triggers require event configuration.",
      });
    }
    if (value.kind === "schedule" && !("schedule" in value.config)) {
      context.addIssue({
        code: "custom",
        path: ["config"],
        message: "Schedule triggers require schedule configuration.",
      });
    }
    if (
      value.kind === "schedule" &&
      (value.nextFireAt === undefined ||
        value.consecutiveFailures === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["nextFireAt"],
        message: "Schedule triggers require next-fire and failure state.",
      });
    }
  });

export type AgentTrigger = z.output<typeof agentTriggerSchema>;
export type AgentTriggerInput = z.input<typeof agentTriggerSchema>;

export const lifecycleEventSchema = z
  .object({
    eventId: identifierSchema,
    agentId: agentIdSchema,
    action: z.enum([
      "created",
      "updated",
      "policy_changed",
      "enabled",
      "disabled",
      "scheduled",
      "skipped",
      "paused",
      "resumed",
      "stopped",
      "retry",
      "circuit_open",
      "trigger_removed",
    ]),
    triggerId: identifierSchema.optional(),
    revision: revisionSchema,
    sequence: z.number().int().positive(),
    occurredAt: timestampSchema,
  })
  .strict();

export type LifecycleEvent = z.output<typeof lifecycleEventSchema>;

export const executionRequestSchema = z
  .object({
    executionId: identifierSchema,
    agentId: agentIdSchema,
    agentRevision: revisionSchema,
    triggerId: identifierSchema.optional(),
    source: z.enum(["github", "schedule", "test"]),
    idempotencyKey: safeText(500),
    target: z
      .object({
        kind: z.enum(["issue", "pull"]),
        owner: safeText(120),
        repo: safeText(120),
        number: z.number().int().positive(),
      })
      .strict(),
    scheduledAt: timestampSchema,
    priority: z.number().int().min(0).max(100),
    createdAt: timestampSchema,
  })
  .strict();

export type ExecutionRequest = z.output<typeof executionRequestSchema>;
export type ExecutionRequestInput = z.input<typeof executionRequestSchema>;

export function targetMatchesScope(
  target: ExecutionRequest["target"],
  scope: AgentDraft["targetScope"],
): boolean {
  return (
    `${target.owner}/${target.repo}`.toLowerCase() ===
    scope.repository.toLowerCase()
  );
}

const queueLeaseSchema = z
  .object({
    leaseId: identifierSchema,
    owner: identifierSchema,
    expiresAt: timestampSchema,
  })
  .strict();

const queueReceiptSchema = z
  .object({
    runId: identifierSchema,
    phase: safeText(100),
    verificationPassed: z.boolean(),
    errorCode: identifierSchema.optional(),
  })
  .strict();

export const queueEntrySchema = z
  .object({
    queueEntryId: identifierSchema,
    executionId: identifierSchema,
    agentId: agentIdSchema,
    agentRevision: revisionSchema,
    state: z.enum([
      "queued",
      "claimed",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
      "dead_letter",
    ]),
    scheduledAt: timestampSchema,
    priority: z.number().int().min(0).max(100),
    attempts: z.number().int().nonnegative(),
    lease: queueLeaseSchema.optional(),
    receipt: queueReceiptSchema.optional(),
    failureCode: identifierSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const active = value.state === "claimed" || value.state === "running";
    if (active && !value.lease) {
      context.addIssue({
        code: "custom",
        path: ["lease"],
        message: "Claimed and running entries require a lease.",
      });
    }
    if (!active && value.lease) {
      context.addIssue({
        code: "custom",
        path: ["lease"],
        message: "Only claimed and running entries may retain a lease.",
      });
    }
  });

export type QueueEntry = z.output<typeof queueEntrySchema>;

export function migrateLegacyActionPresetsInSnapshot(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const snapshot = raw as Record<string, unknown>;
  const triggers = Array.isArray(snapshot.triggers) ? snapshot.triggers : [];
  const revisions = Array.isArray(snapshot.revisions) ? snapshot.revisions : [];
  return {
    ...snapshot,
    revisions: revisions.map((revision) => {
      if (!revision || typeof revision !== "object" || Array.isArray(revision)) {
        return revision;
      }
      const record = revision as Record<string, unknown>;
      const draft = record.draft;
      if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
        return revision;
      }
      const draftRecord = draft as Record<string, unknown>;
      if (draftRecord.actionPreset !== undefined) return revision;
      const agentId = record.agentId;
      const agentTriggers = triggers.filter(
        (trigger) =>
          !!trigger &&
          typeof trigger === "object" &&
          !Array.isArray(trigger) &&
          (trigger as { agentId?: unknown }).agentId === agentId,
      ) as { kind: string; config?: unknown }[];
      return {
        ...record,
        draft: {
          ...draftRecord,
          actionPreset: inferActionPresetFromLegacyDraft(
            draftRecord,
            agentTriggers,
          ),
        },
      };
    }),
  };
}

export const agentControlPlaneSnapshotObjectSchema = z
  .object({
    version: z.literal(1),
    agents: z.array(agentDefinitionSchema),
    revisions: z.array(agentRevisionSchema),
    triggers: z.array(agentTriggerSchema),
    lifecycleEvents: z.array(lifecycleEventSchema),
    executions: z.array(executionRequestSchema),
    queueEntries: z.array(queueEntrySchema),
  })
  .strict();

export const agentControlPlaneSnapshotSchema = z.preprocess(
  migrateLegacyActionPresetsInSnapshot,
  agentControlPlaneSnapshotObjectSchema,
);

export type AgentControlPlaneSnapshot = z.output<
  typeof agentControlPlaneSnapshotSchema
>;

export function createEmptyAgentControlPlaneSnapshot(): AgentControlPlaneSnapshot {
  return {
    version: 1,
    agents: [],
    revisions: [],
    triggers: [],
    lifecycleEvents: [],
    executions: [],
    queueEntries: [],
  };
}
