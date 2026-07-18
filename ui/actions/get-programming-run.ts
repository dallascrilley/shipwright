import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getOperatorRunRegistry } from "../server/operator-runs";

export default defineAction({
  description:
    "Read the latest known status and receipt for one programming-agent run.",
  schema: z.object({ runId: z.string().trim().min(1).max(100).optional() }),
  http: { method: "GET" },
  readOnly: true,
  toolCallable: false,
  run: async ({ runId }) =>
    runId
      ? (getOperatorRunRegistry().get(runId) ?? null)
      : (getOperatorRunRegistry().getLatest() ?? null),
});
