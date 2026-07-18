# ui — Agent Guide

This app adapts the Agent Native chat template into a local programming-agent
operator console. Keep `/` as the receipt-first operator surface and `/chat` as
the shared agent conversation surface.

## Core Rules

- Store large file/blob payloads in configured file/blob storage, not SQL: no
  base64, `data:` URLs, images, video/audio, PDFs, ZIPs, screenshots,
  thumbnails, or replay chunks in app tables, `application_state`, `settings`,
  or `resources`; persist URLs, ids, or handles instead.
- Never hardcode API keys, tokens, webhook URLs, signing secrets, private Builder/internal data, customer data, or credential-looking literals. Use secrets/OAuth/runtime configuration and obvious placeholders in examples.
- Follow the root framework contract: data in SQL, actions first, application
  state for navigation/selection, and shared agent chat for AI work.
- Use actions for app operations and keep frontend/API parity.
- Treat the chat as the default UI. When the user asks for a capability, prefer
  adding or improving the action surface first, then add a page, table, form, or
  widget only when the user needs to inspect, compare, approve, or share durable
  objects.
- If the user wants to plug in their own agent backend, keep the app shell and
  thread UI intact and adapt the chat through the framework's `AgentChatRuntime`
  connector helpers instead of forking the transcript/composer UI.
- Keep the action surface small and orthogonal: every action is a tool in the
  model's context window, so prefer one CRUD-style `update` (patch of fields)
  over many per-field actions, reach for an existing generic query / escape
  hatch (`provider-api-*`, dev `db-query`) before minting a new read action,
  mark UI-only or programmatic actions `agentTool: false` to hide them from the
  model (distinct from `toolCallable: false`, which only gates the extension
  iframe), and delete or hide actions the UI no longer uses. See the `actions`
  skill.
- Keep database code provider-agnostic and additive.
- Use `view-screen` or application state when the active page/selection is
  unclear.
- For new features, update UI, actions, skills/instructions, and application
  state when applicable.

## Application State

- `navigation` should describe the current view and selected entity ids. The
  operator view is `operator` at `/`; chat is `chat` at `/chat`.
- `navigate` may be used to move the UI when the app supports it.
- `view-screen` is the first tool to call when the user's visible context
  matters.

## Operator actions

- `start-programming-run` is the only start boundary. Dry-run is the default,
  publishing requires explicit confirmation, and only one run may be active.
- `get-programming-run` returns a named run or the latest in-process run for
  browser-refresh recovery.
- Keep GitHub App credentials, git publication, verification, and policy in the
  root host pipeline. Never add browser-side GitHub or push logic.
- The V1 registry is local and single-operator; cross-restart resumption and
  multi-user tenancy are intentionally deferred.

## Framework Docs Lookup

- Before implementing or explaining non-trivial Agent Native behavior, use the
  `agent-native-docs` skill and the built-in `docs-search` action/tool to read
  the version-matched framework docs bundled with `@agent-native/core`.
- Use the built-in `source-search` action/tool, or search
  `node_modules/@agent-native/core/corpus`, when you need current core or
  first-party template implementation examples.
- Prefer those installed docs over memory or public docs when package APIs,
  generated-app conventions, workspaces, actions, or agent surfaces are involved.

## Skills

Read the relevant root skill before implementation: `adding-a-feature`,
`actions`, `agent-native-docs`, `storing-data`, `real-time-sync`, `security`,
`delegate-to-agent`, `frontend-design`, `shadcn-ui`, and
`self-modifying-code`.
