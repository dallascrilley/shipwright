import { defineAction } from "@agent-native/core/action";

import { getAgentManagementService } from "../server/agent-management";
import { agentDraftSchema } from "../shared/agent-definition";

export default defineAction({
  description:
    "Create a disabled Shipwright agent draft. A validated trigger is required before it can be enabled.",
  schema: agentDraftSchema,
  agentTool: false,
  toolCallable: false,
  run: async (input) => getAgentManagementService().createAgent(input),
});
