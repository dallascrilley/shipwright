import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getAgentManagementService } from "../server/agent-management";
import { agentDraftSchema } from "../shared/agent-definition";

export default defineAction({
  description:
    "Save an explicit immutable revision for a Shipwright agent configuration.",
  schema: z
    .object({
      agentId: z.string().trim().min(1).max(200),
      expectedRevision: z.number().int().positive(),
      draft: agentDraftSchema,
    })
    .strict(),
  agentTool: false,
  toolCallable: false,
  run: async (input) => getAgentManagementService().saveAgent(input),
});
