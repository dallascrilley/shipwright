import { defineAction } from "@agent-native/core/action";

import { getAgentManagementService } from "../server/agent-management";
import { agentListFilterSchema } from "../shared/agent-management";

export default defineAction({
  description:
    "List Shipwright agent configurations without exposing instructions or secrets.",
  schema: agentListFilterSchema,
  http: { method: "GET" },
  readOnly: true,
  agentTool: false,
  toolCallable: false,
  run: async (input) => getAgentManagementService().listAgents(input),
});
