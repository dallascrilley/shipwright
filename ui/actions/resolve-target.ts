import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { resolveTarget } from "../server/resolve-target";

export default defineAction({
  description:
    "Preflight a GitHub issue or pull request URL for allowlist, title, and pinned head metadata.",
  schema: z.object({
    url: z.string().trim().min(1).max(500),
  }),
  http: { method: "GET" },
  readOnly: true,
  toolCallable: false,
  run: async ({ url }) => resolveTarget(url),
});
