import { defineAction } from "@agent-native/core/action";

import {
  getOperatorRunRegistry,
  isOperatorDemoMode,
} from "../server/operator-runs";
import { operatorRunListRequestSchema } from "../shared/operator-run";

export default defineAction({
  description:
    "List durable Shipwright operator runs with optional search, filters, and cursor paging.",
  schema: operatorRunListRequestSchema,
  http: { method: "GET" },
  readOnly: true,
  toolCallable: false,
  run: async (input) => {
    const page = getOperatorRunRegistry().listPage(input);
    return {
      ...page,
      demoMode: isOperatorDemoMode(),
    };
  },
});
