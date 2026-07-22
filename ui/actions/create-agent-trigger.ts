import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import type { CreateTriggerInput } from "../server/agent-control-plane";
import { getAgentManagementService } from "../server/agent-management";
import {
  curatedGithubTriggerConfigSchema,
  scheduleTriggerConfigSchema,
} from "../shared/agent-definition";

const commonInput = {
  agentId: z.string().trim().min(1).max(200),
  expectedRevision: z.number().int().positive(),
};

const triggerInputSchema = z
  .object({
    ...commonInput,
    kind: z.enum(["github", "schedule"]),
    config: z.union([
      curatedGithubTriggerConfigSchema,
      scheduleTriggerConfigSchema,
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const matchesKind =
      value.kind === "github"
        ? curatedGithubTriggerConfigSchema.safeParse(value.config).success
        : scheduleTriggerConfigSchema.safeParse(value.config).success;
    if (!matchesKind) {
      context.addIssue({
        code: "custom",
        path: ["config"],
        message: `${value.kind} trigger configuration does not match its kind.`,
      });
    }
  });

export default defineAction({
  description:
    "Add a curated GitHub or validated schedule trigger pinned to an agent revision.",
  schema: triggerInputSchema,
  agentTool: false,
  toolCallable: false,
  run: async (input) =>
    getAgentManagementService().createTrigger(input as CreateTriggerInput),
});
