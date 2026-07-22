---
title: In-app chat assistant errors "Engine ai-sdk:openai requires optional packages"
date: 2026-07-22
category: integration
module: ui/chat
tags: [agent-native, ai-sdk, openrouter, model-provider, settings, engine]
severity: high
---

# In-app chat assistant errors "Engine ai-sdk:openai requires optional packages"

## Problem
The operator console at `/settings` (Models section) and the chat surface showed:

```
Engine "ai-sdk:openai" requires optional packages that are not installed in this app.
Run: pnpm add ai @ai-sdk/openai
```

The chat assistant could not run any model.

## Root cause
Shipwright ships an **in-process chat assistant** via `createAgentChatPlugin`
(`ui/server/plugins/agent-chat.ts`). `@agent-native/core` declares every LLM
provider (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@openrouter/ai-sdk-provider`, …)
as **optional peer dependencies** — the host app must install the one it uses.
`ui/package.json` declared **none**, and the chat app's default engine is
`ai-sdk:openai`, so the engine failed to load.

Two independent engines, easy to conflate:

- **Sandbox coding engine** (writes the PRs, runs in the sandbox image): driven by
  `AGENTOS_PROVIDER` / `AGENTOS_MODEL` (e.g. `kimi`/`k3`). `@agent-native/core`
  **never reads `AGENTOS_PROVIDER`** — grep the core dist and it is absent.
- **In-app chat assistant** (operator console chat / Settings > Models): the
  in-process `createAgentChatPlugin` engine. Configured by the plugin's `engine`
  option and framework env (`AGENT_ENGINE`, `OPENROUTER_API_KEY`, `OPENAI_*`, …).

So `AGENTOS_PROVIDER=kimi` being set did nothing for the chat error.

## What didn't work
- **Install `@ai-sdk/openai` + point `OPENAI_*` at Kimi's OpenAI-compatible endpoint**
  (`OPENAI_BASE_URL=https://api.kimi.com/coding/v1`, `OPENAI_MODEL=k3`). This
  clears the package error and works, but leaves the picker on a single provider
  and relies on the framework's *implicit* default engine.
- **Testing specific OpenRouter model slugs** (`anthropic/claude-3.5-haiku`,
  `google/gemini-2.0-flash-001`) returned `No endpoints found` or, with
  `data_collection: "deny"`, `No endpoints available matching your guardrail
  restrictions and data policy` (an OpenRouter **account privacy setting** at
  openrouter.ai/settings/privacy). `openrouter/auto` succeeds where pinned slugs
  fail — the auto-router picks a policy-compliant endpoint.

## Solution
Set the engine **explicitly** in the plugin and install the matching provider
(mirrors `~/Code/vaporkit/server/plugins/agent-chat.ts`):

```ts
// ui/server/plugins/agent-chat.ts
export default createAgentChatPlugin({
  appId: "ui",
  engine: {
    name: "ai-sdk:openrouter",
    config: {
      appName: "Shipwright",
      appUrl: "https://github.com/dallascrilley/shipwright",
      providerOptions: {
        openrouter: {
          provider: { data_collection: "deny" },
          plugins: [{ id: "auto-router",
            allowed_models: ["anthropic/*", "openai/*", "google/*", "z-ai/*"],
            cost_quality_tradeoff: 3 }],
        },
      },
    },
  },
  // …
});
```

- `ui/package.json`: `@openrouter/ai-sdk-provider@^2.9.1` (peers `ai@^6`, matching
  the pinned `ai@6`; v3.0.0 forces `ai@7`). Regenerate the lockfile with the
  pinned pnpm: `corepack pnpm@11.5.2 install --lockfile-only`.
- Env (`/etc/shipwright/shipwright.env`): `AGENT_ENGINE=ai-sdk:openrouter` (also
  makes the framework *global default* match, so the Settings panel default is not
  a broken `ai-sdk:openai`) and `OPENROUTER_API_KEY=sk-or-...`.

Use a **project-scoped** OpenRouter key (per-project billing isolation, mint via
the provisioning key), and it enforces its own spend cap (this one: $5).

## Why it works
The chat engine is a first-class plugin option; left unset it falls back to the
framework's default (`ai-sdk:openai`), whose provider package is an *optional*
peer that was never installed. Declaring `@openrouter/ai-sdk-provider` + pinning
`ai-sdk:openrouter` gives one provider (OpenRouter) that fans out to many models
via the auto-router.

## Prevention
- Adding/porting an agent-native app: **declare the provider package** in the
  host `package.json` and **set `engine` explicitly** — don't rely on the implicit
  default.
- Remember the chat engine is separate from the sandbox coding engine
  (`AGENTOS_PROVIDER`); configuring one does nothing for the other.
- On OpenRouter, prefer `openrouter/auto` and expect `data_collection: "deny"` to
  filter endpoints per the account's privacy policy.
- `~/.npmrc`'s unresolved `${GITHUB_PACKAGES_TOKEN}` warning is noise here —
  `@agent-native/*`, `ai`, and `@ai-sdk/*` are all public on npmjs.
