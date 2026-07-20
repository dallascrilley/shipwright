/**
 * See what the user is currently looking at on screen.
 *
 * Reads and returns the current navigation state from application state.
 *
 * Usage:
 *   pnpm action view-screen
 */

import { defineAction } from "@agent-native/core/action";
import { readAppState } from "@agent-native/core/application-state";
import { z } from "zod";

import { getOperatorRunRegistry } from "../server/operator-runs";

export default defineAction({
  description:
    "See what the user is currently looking at, including navigation and the latest Shipwright run. Always call this first before taking another action.",
  schema: z.object({}),
  http: false,
  readOnly: true,
  run: async () => {
    const navigation = await readAppState("navigation");
    const latestRun = getOperatorRunRegistry().getLatest();

    const screen: Record<string, unknown> = {};
    if (navigation) screen.navigation = navigation;
    if (latestRun) screen.latestRun = latestRun;

    if (Object.keys(screen).length === 0) {
      return "No application state found. Is the app running?";
    }
    return screen;
  },
});
