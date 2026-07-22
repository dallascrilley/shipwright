---
title: Shipwright can use local Codex OAuth as a quota fallback
date: 2026-07-22
category: integration
module: agentos-provider-fallback
tags: [agentos, pi, openai-codex, oauth, provider-fallback]
severity: high
related:
  - docs/solutions/integration/agentos-pi-empty-prompt-result.md
  - docs/solutions/integration/sandbox-bun-verification-runtime.md
---

# Shipwright can use local Codex OAuth as a quota fallback

## Problem

The primary Kimi provider correctly entered the fallback lane after a capacity failure, but the configured `openai/gpt-5.4` API-key attempt remained silent until the ACP deadline. A direct Responses API probe exposed the hidden upstream result: the API project had no available quota, so changing only the model could not restore the review run.

Switching the fallback to `openai-codex/gpt-5.4` and projecting ChatGPT OAuth into AgentOS removed the API-project dependency, but the AgentOS Pi adapter still timed out without model output. The same credential, model, prompt, and Pi `0.60.0` runtime completed successfully when Pi ran directly on the production host and inside the pinned disposable Docker sandbox. That isolated the remaining failure to the AgentOS ACP/V8 transport, not Codex OAuth, Pi, Docker, or the model.

## What didn't work

- Reusing `OPENAI_API_KEY` still depended on the exhausted API billing project.
- Selecting Pi's `openai-codex` provider without an OAuth record left the headless sandbox unauthenticated.
- Running `openai-codex` through AgentOS's Pi ACP/V8 adapter remained silent until its deadline even after valid OAuth was projected.
- The Pi package catalog did not provide the required bridge. `pi-codex-account` manages Pi's own auth store, `pi-codex-token` expects an enterprise PAT, and `pi-gpt` exposes separate ChatGPT tools rather than authenticating Pi's coding-model provider. Adding one of those packages would not remove the schema boundary and would add third-party code to the production agent.

## Root cause

There were two independent boundaries:

1. Codex CLI and Pi can use the same ChatGPT OAuth account, but they persist different JSON shapes. The usable local credential is in `~/.codex/auth.json`, while Pi expects an `openai-codex` OAuth entry in its own agent directory.
2. AgentOS `0.2.7` does not provide a working native Codex path for this deployment. Its Pi ACP/V8 adapter stalled while direct Pi succeeded with identical inputs.

The fallback therefore needs both a least-privilege credential projection and a provider-specific execution path outside the failing ACP adapter.

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
3. Mounts the lockfile-pinned Pi `0.60.0` dependency tree read-only into the existing disposable Docker workspace.
4. Writes the minimal Pi `openai-codex` OAuth record to owner-only temporary storage inside that sandbox.
5. Runs the Codex attempt through Pi's non-interactive CLI in the same cloned workspace; Kimi and other providers continue through AgentOS.
6. Disables package extensions, prompt templates, themes, and session persistence for the fallback attempt while retaining Pi's built-in coding tools and the selected Shipwright skill.
7. Removes the temporary Pi home and auth projection after the attempt, whether it succeeds or fails.
8. Omits the Codex `id_token`, API-key field, and all unrelated local auth state, and keeps paths, tokens, and raw provider errors out of receipts.

No Pi extension is required. The fallback uses the already locked `@mariozechner/pi-coding-agent` package rather than downloading code at runtime.

The fallback remains bounded to one retry and runs only for recognized provider quota, rate-limit, or capacity failures. Agent, verification, policy, and publication failures still do not switch providers.

## Operations

Copy the current signed-in local Codex auth file to `/var/lib/shipwright/codex-auth.json`, then set owner `shipwright:shipwright` and mode `0600`. Do not place it in Git, a release directory, or a deployment artifact. When local Codex rotates the OAuth session, refresh the production copy if the fallback begins returning an authentication failure.

## Verification

Production release `5da38ce` passed two fresh checks:

- Shipwright's own `SandboxWorkspace` and `createAndRunPiAgent` path returned exactly `OK` from `openai-codex/gpt-5.4` inside a new disposable Docker workspace within the two-minute bound.
- No-publish review receipt `9c2abc5b9e781680` recorded `kimi/k3` as `capacity_failed`, `openai-codex/gpt-5.4` as `succeeded`, and `fallbackUsed: true`. The run then reached the independent verification phase and failed separately because the selected target command was `bun test` while that repository sandbox did not provide `bun` (`exit 127`). The authorized pull-request head and its two unresolved current review threads remained unchanged. Follow-up receipt `cf10b590b73e2702`, after [[sandbox-bun-verification-runtime]], preserved the same fallback result and advanced `bun test` to its real repository exit 1 without publishing or changing those threads.

This distinguishes provider recovery from repository verification: the fallback is working even when a later host-controlled gate rejects the run.

## Prevention

Treat API-key OpenAI and ChatGPT OAuth as separate provider credentials even when they select the same model family. Validate the credential at the adapter boundary, project the least data needed by the sandbox, and compare the framework path with the smallest direct provider probe before assigning a silent timeout to credentials or capacity.

References: [Pi package catalog](https://pi.dev/packages), [Pi providers and OAuth](https://pi.dev/docs/latest/providers), [AgentOS repository](https://github.com/rivet-dev/agent-os), [pi-codex-account](https://pi.dev/packages/pi-codex-account), and [pi-gpt](https://pi.dev/packages/pi-gpt).
