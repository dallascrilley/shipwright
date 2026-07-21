import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getAgentManagementService } from "../server/agent-management";

export default defineAction({
  description:
    "Read one Shipwright agent's safe configuration, triggers, queue history, evidence, and audit trail.",
  schema: z.object({ agentId: z.string().trim().min(1).max(200) }).strict(),
  http: { method: "GET" },
  readOnly: true,
  agentTool: false,
  toolCallable: false,
  run: async ({ agentId }) => getAgentManagementService().getAgent(agentId),
});
