import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getAgentManagementService } from "../server/agent-management";

const schema = z
  .object({
    agentId: z.string().trim().min(1).max(200),
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export default defineAction({
  description:
    "Emergency-stop a Shipwright agent: disable it and cancel lease-held work only when its policy permits cancellation.",
  schema,
  agentTool: false,
  toolCallable: false,
  run: async (input) => getAgentManagementService().emergencyStop(input),
});
