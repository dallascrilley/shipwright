import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import {
  getOperatorRunRegistry,
  isOperatorDemoMode,
} from "../server/operator-runs";

export default defineAction({
  description:
    "List recent durable Shipwright operator runs, newest first.",
  schema: z.object({
    limit: z.number().int().min(1).max(200).default(50).optional(),
  }),
  http: { method: "GET" },
  readOnly: true,
  toolCallable: false,
  run: async ({ limit }) => ({
    records: getOperatorRunRegistry().list(limit ?? 50),
    demoMode: isOperatorDemoMode(),
  }),
});
