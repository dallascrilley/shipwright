import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getHostReadiness } from "../server/host-readiness";

export default defineAction({
  description:
    "Return non-secret host readiness for provider, GitHub App, Docker socket, and state store.",
  schema: z.object({}).optional().default({}),
  http: { method: "GET" },
  readOnly: true,
  toolCallable: false,
  run: async () => getHostReadiness(),
});
