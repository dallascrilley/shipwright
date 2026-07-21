import { z } from "zod";

import { containsSecretLikeContent } from "../../src/pipeline/secret-safety";

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

export const agentDraftSchema = z
  .object({
    name: safeText(120),
    instructions: safeText(12_000),
    skillId: identifierSchema,
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
  })
  .strict();

export type AgentDraft = z.output<typeof agentDraftSchema>;
export type AgentDraftInput = z.input<typeof agentDraftSchema>;


export const agentHealthSchema = z
  .object({
    state: z.enum(["idle", "queued", "running", "paused", "failed"]),
    lastExecutionAt: timestampSchema.optional(),
    lastOutcome: z.enum(["succeeded", "failed", "cancelled"]).optional(),
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

const githubTriggerConfigSchema = z
  .object({
    event: z.enum(["issues", "pull_request"]),
    actions: z.array(identifierSchema).min(1).max(16),
  })
  .strict();

const scheduleTriggerConfigSchema = z
  .object({
    schedule: safeText(200),
    timezone: safeText(100),
  })
  .strict();

export const agentTriggerSchema = z
  .object({
    triggerId: identifierSchema,
    agentId: agentIdSchema,
    agentRevision: revisionSchema,
    kind: z.enum(["github", "schedule"]),
    enabled: z.boolean(),
    config: z.union([githubTriggerConfigSchema, scheduleTriggerConfigSchema]),
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
    ]),
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
    createdAt: timestampSchema,
  })
  .strict();

export type ExecutionRequest = z.output<typeof executionRequestSchema>;
export type ExecutionRequestInput = z.input<typeof executionRequestSchema>;


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
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export type QueueEntry = z.output<typeof queueEntrySchema>;

export const agentControlPlaneSnapshotSchema = z
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
