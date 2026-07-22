---
date: 2026-07-22
topic: github-trigger-condition-filtering
origin: docs/brainstorms/2026-07-22-automation-trigger-configuration-requirements.md
---

# GitHub trigger condition filtering: requirements

**Summary:** Add an optional, typed condition editor and evaluator to Shipwright's
four curated GitHub triggers. Conditions narrow when a signed event may enqueue
an agent without changing existing unconditional triggers, publication policy,
or repository authorization.

## Requirements

- **R1. Optional trigger-scoped conditions.** Each curated GitHub trigger may
  contain zero or more conditions. A trigger with no conditions keeps its
  current meaning and remains eligible whenever its event, action, repository,
  agent state, and authorization checks match.
- **R2. Event-aware field catalog.** The first condition catalog must offer
  **Event actor** and **Labels** for issue and pull-request triggers, plus
  **Base branch** and **Draft state** for pull-request triggers. Event actor
  means the signed GitHub payload's `sender.login`, labels mean the event
  subject's current labels, base branch means the pull request's target branch,
  and draft state means the pull request's current boolean draft value. The UI
  must not offer fields that the selected event cannot provide.
- **R3. Bounded typed operators.** Event actor and base branch support
  **is one of** and **is not one of**. Labels support **include any**,
  **include all**, and **include none**. Draft state supports **is draft** and
  **is not draft**. Login and label comparison are case-insensitive; branch
  comparison uses GitHub's exact delivered name. Operators accept typed,
  bounded values rather than arbitrary expressions.
- **R4. Flat AND semantics.** Every condition on one trigger must match before
  that trigger matches. Operators do not create nested groups. An operator who
  needs OR creates another trigger for the same event and repository with a
  different condition set.
- **R5. One execution per agent revision and delivery.** Multiple matching
  trigger alternatives for the same agent revision are OR alternatives, not
  duplicate work. One signed GitHub delivery may enqueue at most one execution
  for an agent revision, preserving the current replay-idempotency boundary.
- **R6. Fail-closed validation and evaluation.** Unsupported fields,
  operators, value shapes, empty required values, and out-of-bound condition
  lists are rejected when configuration is saved. If a valid condition's field
  is absent or malformed in a delivered event, that condition does not match
  and no execution is queued through that trigger. Evaluation errors never
  degrade to an unconditional match.
- **R7. Readable configuration workflow.** The trigger editor must provide an
  event-aware **Add condition** control with field, operator, and value inputs.
  Saved and review states must read as concise sentences, for example:
  “Pull request created in `owner/repo` when base branch is one of `main` and
  draft state is not draft.” Existing test-before-enable, immutable revision,
  replacement, and removal behavior remains intact.
- **R8. Versioned portable representation.** Copy-as-JSON must include each
  trigger's typed conditions in deterministic order and distinguish the
  conditioned contract from the existing version-1 unconditional projection.
  Existing version-1 exports and persisted unconditional triggers retain their
  original meaning. Condition JSON never contains credentials or raw webhook
  payloads.
- **R9. Signed-event evaluation boundary.** Conditions are evaluated only after
  the existing body limit, HMAC verification, event/action parsing, repository
  scope, and enabled-agent checks succeed, and before queue dispatch. The
  existing start-time authorization check remains required before agent work
  begins. Schedule triggers and manual test runs do not silently apply GitHub
  event conditions.
- **R10. Bounded redacted evidence.** Operators must be able to distinguish an
  accepted event from an event rejected by conditions using bounded typed
  reason codes, trigger identifiers, and match counts. Evidence may retain the
  configured condition values already present in the pinned revision, but must
  not retain raw payloads or copy delivered actor, label, branch, title, or body
  values into receipts.
- **R11. Existing safety gates remain authoritative.** Conditions only narrow
  trigger eligibility. They cannot enable an agent, widen repository scope,
  change instructions or tools, bypass start-time authorization, alter
  verification or publication policy, or weaken exact-head and confirmation
  gates. `dry_run` remains the default publication policy.
- **R12. Bounded initial scale.** A trigger supports at most 10 condition rows;
  a membership condition supports at most 25 non-empty values; and each value
  is at most 100 characters after surrounding whitespace is removed. Duplicate
  values normalize deterministically. Exceeding a bound is a save-time error,
  not truncation.
- **R13. End-to-end proof.** Acceptance requires signed HTTP tests for matching,
  non-matching, missing-field, multiple-alternative, and replay deliveries.
  Proof must show one queue entry for a matching delivery, none for a rejected
  delivery, no raw payload retention, and no change to the agent's publication
  policy. Production rollout remains dry-run-only and reversible.

## Scope boundaries

**In:** typed conditions on the four existing curated GitHub trigger choices;
event-aware condition selection; flat AND evaluation; OR through multiple
triggers; deterministic JSON projection; safe reason evidence; compatibility
with unconditional and legacy trigger records; signed HTTP proof.

**Out:** raw event/action names; arbitrary boolean expressions; nested AND/OR
groups; regex; JSONPath; scripts or user code; changed-file filters; title/body
text matching; schedule conditions; additional GitHub event types; JSON import;
multi-repository agents; automatic publication-policy changes.

**Deferred:** changed-file conditions, richer author/assignee/reviewer fields,
scheduled-trigger redesign, saved reusable condition groups, and generic action
or tool graphs. Each requires a separate requirements cycle.

## Key decisions

- **Flat AND first** — it covers the initial filtering need while keeping UI,
  evaluation, and evidence reviewable.
- **Multiple triggers provide OR** — the existing trigger lifecycle already
  provides a visible, independently removable alternative without a group DSL.
- **GitHub event sender is the actor** — this is available across all four
  curated events and avoids conflating who caused an event with the issue or
  pull-request author.
- **Missing data is a non-match** — condition filters are eligibility gates and
  must never fail open.
- **Conditions narrow only** — authorization, lifecycle, verification, and
  publication remain separate authoritative gates.
- **One execution per revision and delivery** — overlapping alternatives do not
  duplicate agent work.

## Prior learnings applied

- `docs/brainstorms/2026-07-22-automation-trigger-configuration-requirements.md`
  — preserve the condition-ready trigger boundary, readable configuration,
  immutable revisions, and dry-run-first lifecycle.
- `docs/plans/2026-07-21-shipwright-cursor-agents-parity-plan.md` — retain
  signature verification, idempotency, bounded metadata, server-side
  credentials, and policy-governed writes.
- `docs/solutions/integration/github-webhook-library-without-http-route.md` —
  require proof through the real signed HTTP adapter and durable queue state;
  library-only evaluator tests are insufficient.

## Open questions

- **Deferred to planning:** choose the exact persisted schema and configuration
  projection version transition while preserving the R1 and R8 compatibility
  contract.
- **Deferred to planning:** choose whether condition rejection evidence belongs
  in lifecycle events, ingress receipts, aggregate metrics, or a combination,
  provided R10's operator visibility and redaction rules are met.
