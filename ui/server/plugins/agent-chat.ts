import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";

const INITIAL_TOOL_NAMES = ["view-screen", "navigate", "hello"];

export default createAgentChatPlugin({
  appId: "ui",
  engine: {
    name: "ai-sdk:openrouter",
    config: {
      appName: "Shipwright",
      appUrl: "https://github.com/dallascrilley/shipwright",
      providerOptions: {
        openrouter: {
          provider: {
            data_collection: "deny",
          },
          plugins: [
            {
              id: "auto-router",
              allowed_models: ["anthropic/*", "openai/*", "google/*", "z-ai/*"],
              cost_quality_tradeoff: 3,
            },
          ],
        },
      },
    },
  },
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  initialToolNames: INITIAL_TOOL_NAMES,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You are Shipwright's operator assistant.

Shipwright turns authorized GitHub issues into independently verified pull requests. Actions are the contract shared by chat, UI, HTTP, MCP, A2A, and CLI.

Use actions as the source of truth. Start by inspecting the current screen when context matters. Never publish without explicit operator approval. Keep GitHub credentials server-side and describe receipt evidence precisely.`,
});
