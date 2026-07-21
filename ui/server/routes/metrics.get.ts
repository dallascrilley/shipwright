import { defineEventHandler, setHeader, setResponseStatus } from "h3";

import { getAgentManagementService, DEFAULT_LEASE_DURATION_MS } from "../agent-management";
import { buildMetricsText } from "../control-plane-observability";
import { resolveRolloutStage } from "../control-plane-runtime";

/**
 * Aggregate Prometheus exposition. Never emits identifiers, repository or
 * operator data — see buildMetricsText for the explicit allowlist. Fails
 * closed with 503 and no label values when state is unreadable.
 */
export default defineEventHandler((event) => {
  setHeader(event, "content-type", "text/plain; version=0.0.4; charset=utf-8");
  try {
    return buildMetricsText({
      snapshot: getAgentManagementService().getSnapshot(),
      stage: resolveRolloutStage(),
      now: new Date().toISOString(),
      leaseDurationMs: DEFAULT_LEASE_DURATION_MS,
    });
  } catch (error) {
    console.error("control-plane metrics render failed", error);
    setResponseStatus(event, 503);
    return "# shipwright metrics unavailable\n";
  }
});
