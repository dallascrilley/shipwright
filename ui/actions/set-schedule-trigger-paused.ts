import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getAgentManagementService } from "../server/agent-management";

const schema = z
  .object({
    triggerId: z.string().trim().min(1).max(200),
    paused: z.boolean(),
  })
  .strict();

export default defineAction({
  description:
    "Pause or resume an existing schedule trigger without changing its pinned revision.",
  schema,
  agentTool: false,
  toolCallable: false,
  run: async ({ triggerId, paused }) => {
    const service = getAgentManagementService();
    return paused
      ? service.pauseScheduleTrigger(triggerId)
      : service.resumeScheduleTrigger(triggerId);
  },
});
