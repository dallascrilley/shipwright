import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getAgentManagementService } from "../server/agent-management";

const schema = z
  .object({
    agentId: z.string().trim().min(1).max(200),
    expectedRevision: z.number().int().positive(),
    enabled: z.boolean(),
  })
  .strict();

export default defineAction({
  description:
    "Explicitly enable or disable a Shipwright agent. Enabling requires a validated trigger.",
  schema,
  agentTool: false,
  toolCallable: false,
  run: async (input) => getAgentManagementService().setAgentEnabled(input),
});
