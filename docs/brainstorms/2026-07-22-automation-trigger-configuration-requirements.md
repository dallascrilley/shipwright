---
date: 2026-07-22
topic: automation-trigger-configuration
origin: docs/ideation/2026-07-20-shipwright-operator-console-capabilities.md
---

# Automation trigger configuration: requirements

**Summary:** Make Shipwright agents configurable from the repositories the GitHub App can actually access under `dallascrilley` and `dallascrilleymartech`. An operator can save explicit instructions, choose clear GitHub trigger events, test the agent, and enable it without weakening Shipwright's host-owned authorization or publication gates.

## Grounded current state

- Owner-scoped `owner/*` authorization, durable agent definitions, signed GitHub trigger ingestion, schedules, and the Agents console are already on `origin/main`.
- The current Agents console still asks for a free-form `owner/repository`, exposes raw `issues` / `pull_request` event names and comma-separated action strings, and has no trigger-condition model.
- Existing agents already start disabled, retain immutable revisions, support explicit instructions, offer test runs, and default to `dry_run`; this work improves configuration and selection rather than rebuilding those controls.

## Requirements

- **R1. Owner-scoped repository authorization.** Shipwright must permit repositories owned by `dallascrilley` or `dallascrilleymartech` while rejecting repositories outside those owners. Existing exact `owner/repository` entries remain valid for narrower deployments.
- **R2. Accessible repository selection.** Agent creation and editing must provide a searchable repository selector containing only repositories that are both accessible to the configured GitHub App and permitted by R1. An unavailable or failed catalog must fail closed with an actionable operator message rather than silently accepting an unverified repository.
- **R3. Start-time reauthorization.** Selecting or saving a repository is not lasting authorization. Every test, triggered, or manually started execution must re-resolve the canonical repository and reapply the current authorization policy before work begins.
- **R4. Persistent agent configuration.** Each agent must retain a name, one selected repository scope, optional branch scope, explicit agent instructions, skill, tool allowance, verification policy, publication policy, enabled state, and one or more triggers. Historical executions remain linked to the immutable configuration revision they used.
- **R5. Curated GitHub triggers.** The initial trigger picker must offer four readable choices with exact GitHub semantics: **Issue created** (`issues.opened`), **Issue edited** (`issues.edited`), **Pull request created** (`pull_request.opened`), and **Commits pushed to pull request** (`pull_request.synchronize`). Operators must not need to type raw webhook event or action names for these choices.
- **R6. Readable trigger editing.** Trigger configuration and review must read as a concise sentence that combines the selected event and repository. An agent may have multiple supported triggers for its selected repository, and each trigger can be removed or replaced without rewriting prior run history.
- **R7. Explicit instructions.** The instructions editor must remain a prominent, required part of agent configuration. The pinned instructions from the selected revision are the instructions delivered to the agent; the UI must not imply that later edits change queued or historical executions.
- **R8. Versioned JSON representation.** A saved agent must have a stable, versioned JSON representation that round-trips the repository scope, triggers, instructions, execution settings, and enabled state without loss. Secret values and raw webhook payloads are never part of this representation.
- **R9. Safe activation and execution.** New agents remain disabled until explicitly enabled. The operator can test a pinned revision before enabling it. `dry_run` remains the default publication policy; broader policies continue to require their existing authorization, verification, exact-head, branch-protection, and confirmation controls.
- **R10. Trigger safety and evidence.** Trigger deliveries must remain signature-verified, idempotent, repository-scoped, and reauthorized at dispatch. Persist only bounded event metadata and redacted evidence needed to understand why a run was or was not created.
- **R11. Condition-ready trigger boundary.** The trigger model and UI wording must preserve a clear place for future trigger-scoped conditions without changing the meaning of existing unconditional triggers. Existing triggers are interpreted as “when this event occurs in this repository” until conditions are explicitly added.

## Scope boundaries

**In:** owner-scoped authorization configuration for both approved owners; accessible-repository discovery and selection; the four curated GitHub trigger choices; readable trigger rows; required instructions; versioned JSON round-tripping; disabled-by-default test/enable flow; current safety rechecks and evidence.

**Out:** arbitrary webhook names or user-defined event strings; arbitrary expressions, JSONPath, scripts, or code hooks; multi-operator tenancy; repositories outside the two approved owners; automatic modification of agent instructions or policies; weakening existing publication safeguards.

**Deferred:** a condition editor and evaluator. Its first typed fields should be pull-request draft state, base branch, actor, and labels, using bounded operators such as equals, includes, and allow/deny membership. Changed-file conditions, multi-repository agents, additional GitHub events, scheduled-trigger redesign, and unrestricted publish automation require separate requirements.

## Key decisions

- **Persistent agent profiles, not an expanded manual run form** — configuration, trigger lifecycle, instructions, and history belong to the existing Agents surface.
- **GitHub App inventory intersected with authorization policy** — being visible to the App is necessary but never sufficient; R1 and R3 remain authoritative.
- **One repository per agent with multiple triggers** — this keeps instructions, verification, and evidence legible while avoiding hidden cross-repository blast radius.
- **Human-readable choices over raw webhook strings** — product labels communicate intent while the saved representation retains exact GitHub semantics.
- **JSON is a portable representation, not a generic workflow DSL** — Shipwright does not need Cursor's arbitrary action/tool graph to deliver the requested behavior.
- **Dry-run-first rollout** — triggered publication is not required for this slice and existing publication policies remain separately governed.

## Prior learnings applied

- `docs/ideation/2026-07-20-shipwright-operator-console-capabilities.md` — preserve Cursor's readable configuration-versus-history separation, explicit instructions, and test-run affordance without cloning its private product.
- `docs/plans/2026-07-21-shipwright-cursor-agents-parity-plan.md` — retain immutable revisions, idempotent trigger receipts, disabled-by-default lifecycle, server-side credentials, and policy-governed writes.
- `docs/plans/2026-07-20-feat-operator-console-capabilities-plan.md` — keep the manual Operator console dry-run-first and confirmation-gated; automation configuration remains a distinct Agents surface.

## Open questions

- **Deferred to planning:** repository-catalog refresh and cache behavior, including the operator-visible recovery path when GitHub is temporarily unavailable.
- **Deferred to planning:** compatibility handling for existing GitHub triggers that contain raw action strings outside the four curated choices.
- **Deferred to the conditions requirements cycle:** the exact typed field/operator matrix and whether all conditions are combined with AND before any OR grouping is introduced.
