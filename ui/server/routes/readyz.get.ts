import { defineEventHandler, setResponseStatus } from "h3";

import { resolveShipwrightStateDirectory } from "../../../src/config/state.js";
import { parseGitHubWebhookConfig } from "../../../src/config/github.js";
import { getAgentManagementService } from "../agent-management";
import { buildControlPlaneReadiness } from "../control-plane-observability";
import { resolveRolloutStage } from "../control-plane-runtime";

/**
 * Readiness: durable control-plane state loads, and an active scheduler is
 * not overdue. Returns 503 with redacted reasons when the service cannot
 * safely accept traffic.
 */
export default defineEventHandler((event) => {
  try {
    // The public webhook is part of the always-on service contract. Report the
    // process unready before traffic arrives when either App trust tuple is
    // incomplete; the route uses this same parser for every delivery.
    parseGitHubWebhookConfig();
    const status = buildControlPlaneReadiness({
      snapshot: getAgentManagementService().getSnapshot(),
      stage: resolveRolloutStage(),
      storePath: `${resolveShipwrightStateDirectory()}/agent-control-plane.json`,
      now: new Date().toISOString(),
    });
    if (!status.ok) setResponseStatus(event, 503);
    return status;
  } catch (error) {
    // Detail stays in server logs; the public probe gets a fixed reason.
    console.error("control-plane readiness probe failed", error);
    setResponseStatus(event, 503);
    return {
      ok: false,
      reasons: ["control-plane state unreadable"],
    };
  }
});
