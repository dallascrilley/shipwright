import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import type { CreateTriggerInput } from "../server/agent-control-plane";
import { getAgentManagementService } from "../server/agent-management";

const triggerInputSchema = z
  .object({
    agentId: z.string().trim().min(1).max(200),
    expectedRevision: z.number().int().positive(),
    kind: z.enum(["github", "schedule"]),
    config: z.union([
      z
        .object({
          event: z.enum(["issues", "pull_request"]),
          actions: z.array(z.string().trim().min(1)).min(1).max(16),
        })
        .strict(),
      z
        .object({
          schedule: z.string().trim().min(1).max(200),
          timezone: z.string().trim().min(1).max(100),
          target: z
            .object({
              kind: z.enum(["issue", "pull"]),
              number: z.number().int().positive(),
            })
            .strict(),
        })
        .strict(),
    ]),
  })
  .strict();

export default defineAction({
  description:
    "Add a validated GitHub or schedule trigger pinned to an agent revision.",
  schema: triggerInputSchema,
  agentTool: false,
  toolCallable: false,
  run: async (input) =>
    getAgentManagementService().createTrigger(input as CreateTriggerInput),
});
