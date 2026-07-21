import { defineNitroPlugin } from "@agent-native/core";

import { getAgentManagementService } from "../agent-management";
import { resolveRolloutStage } from "../control-plane-runtime";

/**
 * U6: give the service process ownership of the scheduler and queue
 * dispatcher, but only when the operator has selected a rollout stage.
 * Default deployments resolve to `disabled` and start no worker loop.
 */
export default defineNitroPlugin(async () => {
  if (resolveRolloutStage() === "disabled") return;
  const runtime = getAgentManagementService().createRuntime();
  runtime.start();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => runtime.stop());
  }
});
