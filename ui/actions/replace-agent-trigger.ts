import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getAgentManagementService } from "../server/agent-management";
import {
  curatedGithubTriggerConfigSchema,
  agentTriggerSchema,
} from "../shared/agent-definition";

export default defineAction({
  description:
    "Atomically replace one active GitHub trigger at the expected agent revision.",
  schema: z
    .object({
      agentId: z.string().trim().min(1).max(200),
      expectedRevision: z.number().int().positive(),
      triggerId: z.string().trim().min(1).max(200),
      kind: z.literal("github"),
      config: curatedGithubTriggerConfigSchema,
    })
    .strict(),
  outputSchema: agentTriggerSchema,
  outputErrorStrategy: "strict",
  agentTool: false,
  toolCallable: false,
  run: async (input) => getAgentManagementService().replaceTrigger(input),
});
