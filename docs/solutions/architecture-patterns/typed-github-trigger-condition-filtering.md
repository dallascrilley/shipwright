---
title: Typed GitHub trigger filters must narrow signed deliveries before dispatch
date: 2026-07-22
category: architecture-patterns
module: automation-trigger-ingress
tags: [github-webhook, trigger-conditions, fail-closed, idempotency, redaction]
applies_when: [adding webhook filters, exposing automation decisions]
related:
  - docs/solutions/integration/github-webhook-library-without-http-route.md
---

# Typed GitHub trigger filters must narrow signed deliveries before dispatch

## Context

Shipwright needed readable conditions for issue and pull-request automations
without turning the webhook into a general expression engine or weakening its
existing HMAC, repository, activation, idempotency, and publication controls.
Multiple trigger records are valid alternatives for one agent revision, so
evaluating and dispatching each record independently could also produce
redundant enqueue attempts and misleading evidence.

## Guidance

Represent conditions as a strict discriminated union in
`ui/shared/agent-definition.ts`: actor and base-branch membership, label
membership, and a draft-state predicate. Validate event applicability and
bounds at persistence. Keep an omitted condition array backward-compatible and
unconditional; emit explicit arrays in version-2 Copy-as-JSON output.

After the HTTP body limit, HMAC verification, JSON parsing, repository scope,
and enabled-state checks, extract only a narrow condition context. Preserve
three field states—available, missing, and malformed—so a configured condition
can fail closed with a precise reason code. Never pass the raw body into the
pure evaluator.

Evaluate rows within a trigger with AND. Group eligible triggers by agent and
revision, evaluate each trigger as an OR alternative, then choose the first
matching trigger ID in stable order and dispatch once. Retain the delivery plus
revision idempotency key as the replay backstop.

Expose only bounded evidence: aggregate match/filter counts, at most 20
`{triggerId, decision, reasonCodes}` entries, and a truncation count. Do not
store or return raw payloads or observed actor, label, branch, draft, title, or
body values. Prove this through a correctly signed request to the mounted H3
route, durable queue inspection, and replay of the same delivery—not only a
library test. This extends [[github-webhook-library-without-http-route]].

## Why it works

The ordering makes filters safety-monotonic: they can remove otherwise eligible
work but cannot bypass authentication or authorization. Grouping alternatives
before dispatch gives OR semantics without duplicate execution, while the
idempotency key protects retries across repeated deliveries. Typed field states
and reason-code-only receipts keep malformed events diagnosable without making
delivered data durable.

## When to apply

Use this pattern whenever a signed webhook gains operator-configurable filters.
Add new fields as explicit union variants with event-specific extraction and
tests. Do not tunnel regex, JSONPath, scripts, or arbitrary expressions through
an untyped catch-all. Every new filter should have a mounted-route test covering
match, non-match, missing/malformed data, alternative convergence, replay,
receipt bounds, and redaction.
