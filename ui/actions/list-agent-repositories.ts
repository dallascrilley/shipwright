import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getAgentRepositoryCatalog } from "../server/repository-catalog";
import { agentRepositoryCatalogResultSchema } from "../shared/repository-catalog";

export default defineAction({
  description:
    "List GitHub App-accessible repositories allowed for Shipwright agents.",
  schema: z.object({}).optional().default({}),
  outputSchema: agentRepositoryCatalogResultSchema,
  outputErrorStrategy: "strict",
  http: { method: "GET" },
  readOnly: true,
  agentTool: false,
  toolCallable: false,
  run: async () => getAgentRepositoryCatalog().list(),
});
