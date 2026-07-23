import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getAgentManagementService } from "../server/agent-management";
import { agentDefinitionExportSchema } from "../shared/agent-management";

export default defineAction({
  description:
    "Return the current versioned, secret-free Shipwright agent configuration document.",
  schema: z.object({ agentId: z.string().trim().min(1).max(200) }).strict(),
  outputSchema: agentDefinitionExportSchema,
  outputErrorStrategy: "strict",
  http: { method: "GET" },
  readOnly: true,
  agentTool: false,
  toolCallable: false,
  run: async ({ agentId }) =>
    getAgentManagementService().exportAgentDefinition(agentId),
});
