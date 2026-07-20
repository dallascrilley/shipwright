import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getOperatorRunRegistry } from "../server/operator-runs";

export default defineAction({
  description: "Cancel an in-flight Shipwright operator run.",
  schema: z.object({
    runId: z.string().trim().min(1).max(100),
  }),
  toolCallable: false,
  run: async ({ runId }) => getOperatorRunRegistry().cancel(runId),
});
