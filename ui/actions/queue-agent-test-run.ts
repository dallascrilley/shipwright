import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getAgentManagementService } from "../server/agent-management";

const schema = z
  .object({
    agentId: z.string().trim().min(1).max(200),
    expectedRevision: z.number().int().positive(),
    target: z
      .object({
        kind: z.enum(["issue", "pull"]),
        number: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export default defineAction({
  description:
    "Queue a dry-run test against the agent's current pinned revision; this action never publishes or starts a worker.",
  schema,
  agentTool: false,
  toolCallable: false,
  run: async (input) => getAgentManagementService().queueTestRun(input),
});
