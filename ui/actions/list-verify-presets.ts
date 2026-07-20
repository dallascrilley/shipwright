import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { listVerifyPresets } from "../server/verify-presets";

export default defineAction({
  description: "List server-owned Shipwright verification command presets.",
  schema: z.object({}).optional().default({}),
  http: { method: "GET" },
  readOnly: true,
  toolCallable: false,
  run: async () => listVerifyPresets(),
});
