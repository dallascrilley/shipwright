import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getAgentManagementService } from "../server/agent-management";
import { agentTriggerSchema } from "../shared/agent-definition";

export default defineAction({
  description:
    "Remove one active Shipwright agent trigger at the expected agent revision.",
  schema: z
    .object({
      agentId: z.string().trim().min(1).max(200),
      expectedRevision: z.number().int().positive(),
      triggerId: z.string().trim().min(1).max(200),
    })
    .strict(),
  outputSchema: agentTriggerSchema,
  outputErrorStrategy: "strict",
  agentTool: false,
  toolCallable: false,
  run: async (input) => getAgentManagementService().removeTrigger(input),
});
