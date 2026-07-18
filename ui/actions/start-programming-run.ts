import { defineAction } from "@agent-native/core/action";

import { getOperatorRunRegistry } from "../server/operator-runs";
import { operatorRunRequestSchema } from "../shared/operator-run";

export default defineAction({
  description:
    "Start a GitHub issue programming-agent run. Dry-run is the default. Publishing requires explicit approval.",
  schema: operatorRunRequestSchema,
  needsApproval: (input) => input.publish,
  toolCallable: false,
  run: async (input) => getOperatorRunRegistry().start(input),
});
