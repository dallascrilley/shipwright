---
title: AgentOS can use local Codex OAuth as a quota fallback
date: 2026-07-22
category: integration
module: agentos-provider-fallback
tags: [agentos, pi, openai-codex, oauth, provider-fallback]
severity: high
related: [docs/solutions/integration/agentos-pi-empty-prompt-result.md]
---

# AgentOS can use local Codex OAuth as a quota fallback

## Problem

The primary Kimi provider correctly entered the fallback lane after a capacity failure, but the configured `openai/gpt-5.4` API-key attempt remained silent until the ACP deadline. A direct Responses API probe exposed the hidden upstream result: the API project had no available quota, so changing only the model could not restore the review run.

## What didn't work

- Reusing `OPENAI_API_KEY` still depended on the exhausted API billing project.
- Selecting Pi's `openai-codex` provider without an OAuth record left the headless sandbox unauthenticated.
- The Pi package catalog did not provide the required bridge. `pi-codex-account` manages Pi's own auth store, `pi-codex-token` expects an enterprise PAT, and `pi-gpt` exposes separate ChatGPT tools rather than authenticating Pi's coding-model provider. Adding one of those packages would not remove the schema boundary and would add third-party code to the production agent.

## Root cause

Codex CLI and Pi can use the same ChatGPT OAuth account, but they persist different JSON shapes. The usable local credential is in `~/.codex/auth.json`, while Pi expects an `openai-codex` OAuth entry in `~/.pi/agent/auth.json`. AgentOS creates a disposable VM for each attempt, so the required Pi auth entry must be projected into that VM before its session starts.

## Solution

Configure a Codex auth source and select the OAuth-backed fallback:

```dotenv
AGENTOS_CODEX_AUTH_FILE=/var/lib/shipwright/codex-auth.json
AGENTOS_FALLBACK_PROVIDER=openai-codex
AGENTOS_FALLBACK_MODEL=gpt-5.4
```

Shipwright now:

1. Requires the source to be a regular file owned by the Shipwright process user with no group or world permissions.
2. Parses only `tokens.access_token`, `tokens.refresh_token`, and `tokens.account_id`, deriving the expiry from the access token.
3. Writes the minimal Pi `openai-codex` OAuth record inside the disposable AgentOS VM before creating the Pi session.
4. Omits the Codex `id_token`, API-key field, and all unrelated local auth state.
5. Keeps the host auth path and every token value out of provider-attempt receipts and normalized errors.

The fallback remains bounded to one retry and runs only for recognized provider quota, rate-limit, or capacity failures. Agent, verification, policy, and publication failures still do not switch providers.

## Operations

Copy the current signed-in local Codex auth file to `/var/lib/shipwright/codex-auth.json`, then set owner `shipwright:shipwright` and mode `0600`. Do not place it in Git, a release directory, or a deployment artifact. When local Codex rotates the OAuth session, refresh the production copy if the fallback begins returning an authentication failure.

## Prevention

Treat API-key OpenAI and ChatGPT OAuth as separate provider credentials even when they select the same model family. Validate the credential at the adapter boundary, project the least data needed by the sandbox, and use a direct minimal provider probe before interpreting a long ACP timeout as an AgentOS failure.

References: [Pi package catalog](https://pi.dev/packages), [pi-codex-account](https://pi.dev/packages/pi-codex-account), and [pi-gpt](https://pi.dev/packages/pi-gpt).
