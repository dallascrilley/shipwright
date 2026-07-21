import { createAuthPlugin } from "@agent-native/core/server";

const rawAppTitle = "Ui";
const appTitle = rawAppTitle === "{" + "{APP_TITLE}}" ? "Chat" : rawAppTitle;

export default createAuthPlugin({
  // Loopback systemd probes and tailnet metric scrapes must reach these
  // without a session; the handlers expose only aggregate counts, never
  // operator data (see server/control-plane-observability.ts).
  publicPaths: ["/healthz", "/readyz", "/metrics"],
  marketing: {
    appName: appTitle,
    tagline:
      "Start from a chat-first agent-native app and add actions, screens, and workflows as you grow.",
    features: [
      "Full-page chat with durable threads and tool call history",
      "Add actions once and use them from chat, UI, HTTP, MCP, A2A, and CLI",
      "Plug in your own agent runtime or build on the included app-agent loop",
    ],
  },
});
