---
title: AgentOS Pi can resolve a prompt without a usable agent outcome
date: 2026-07-22
category: integration
module: agentos-review-runner
tags: [agentos, pi, acp, review-agent, outcome-artifact]
severity: high
related: [docs/solutions/integration/agent-native-chat-engine-provider.md]
---

# AgentOS Pi can resolve a prompt without a usable agent outcome

## Problem

A production no-publish review reached the fallback provider, then failed with:

```text
review agent finished without writing .agentos-review-resolution.json ... agent response: (no agent output)
```

The receipt incorrectly recorded the provider attempt as `succeeded`, even though the agent returned no text and never satisfied its required outcome-artifact contract.

## What didn't work

The earlier missing-artifact handler surfaced the agent response after `cat` failed. That improved provider-error visibility, but an empty response still discarded the only remaining diagnostic boundary and left a generic `agent_failed` receipt.

Treating a resolved `AgentOs.prompt()` promise as success was also insufficient. Its result contains both streamed `text` and a raw ACP JSON-RPC `response`; a resolved promise may therefore carry `response.error` or an empty completed turn.

## Solution

Validate both parts of the prompt result in `src/agent/runner.ts:145`:

- Reject ACP `response.error` values instead of returning empty text.
- If the first turn has no text, issue one bounded recovery prompt in the same session so existing context and workspace changes are preserved.
- If the recovery is also empty, fail with `agent_output_missing` and record only safe event counts: message chunks, thought chunks, tool calls, and tool failures. Never persist event content or tool arguments.
- In `src/pipeline/review-run.ts:139`, classify an absent required artifact as `agent_outcome_missing` and downgrade the last attempt from `succeeded` to `failed`.

Regression coverage lives in `test/agent/runner.test.ts`, `test/pipeline/review-run.test.ts`, and `test/pipeline/run.test.ts`.

## Why it works

ACP transport completion and agent-contract completion are different boundaries. Inspecting the raw RPC response catches transport errors; the same-session retry recovers a transient empty final turn without re-creating the VM; specific terminal codes and content-free counters make unrecovered failures actionable without leaking model reasoning, prompts, repository content, or secrets.

## Prevention

For every AgentOS adapter, validate the structured RPC result before interpreting streamed text. Do not mark a provider attempt successful until the agent-facing contract has usable output, and never rely on free-form response text as the sole diagnostic channel.

The coding-agent provider is separate from the UI chat provider described in [[agent-native-chat-engine-provider]]; verify the correct integration boundary before changing provider configuration.
