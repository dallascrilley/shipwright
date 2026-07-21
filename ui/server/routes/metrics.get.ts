import { defineEventHandler, setHeader } from "h3";

import { getAgentManagementService } from "../agent-management";
import { buildMetricsText } from "../control-plane-observability";
import { resolveRolloutStage } from "../control-plane-runtime";

/**
 * Aggregate Prometheus exposition. Never emits identifiers, repository or
 * operator data — see buildMetricsText for the explicit allowlist.
 */
export default defineEventHandler((event) => {
  setHeader(event, "content-type", "text/plain; version=0.0.4; charset=utf-8");
  return buildMetricsText({
    snapshot: getAgentManagementService().getSnapshot(),
    stage: resolveRolloutStage(),
    now: new Date().toISOString(),
  });
});
