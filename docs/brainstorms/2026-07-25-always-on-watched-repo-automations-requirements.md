---
date: 2026-07-25
topic: always-on-watched-repo-automations
origin: docs/brainstorms/2026-07-25-always-on-agents-gap-assessment.md
---

# Always-on watched-repo automations: requirements

**Summary:** Turn Shipwright's already-shipped agent control plane into a live always-on service for allowlisted repositories. An operator configures a watched repo, curated GitHub trigger, and action preset (fix issue or resolve PR feedback); the remote pin receives signed events, runs the sandbox pipeline, and—only after staged rollout proof—publishes under fail-closed policy. Retire the local fleet PR poller for covered repos.

## Grounded current state

- Phase 2 (`td-a9f0ff`), automation trigger configuration (`td-c4c766`), and typed conditions (`td-18bac8`) are closed on `origin/main`.
- Durable agents, signed webhook ingress, schedules, queue/leases, Agents console, and Docker sandbox pipelines already exist.
- Production defaults to `SHIPWRIGHT_ROLLOUT_STAGE=disabled`; webhook callback remains operator-configured.
- Queue execution chooses issue vs review mode from the GitHub target kind (`pull` → review + `skillId`; otherwise issue). There is no first-class action-preset field in the agent editor.
- Skill registry currently exposes `fix-review-findings` for review runs only.
- Local `.agents-state/fleet-pr-watch.py` remains the operational stopgap for multi-repo PR watch/dispatch.

## Requirements

- **R1. Live activation runbook.** Document and prove a reversible checklist to advance the remote pin through `test_only` → `dry_run` with: `GITHUB_WEBHOOK_SECRET`, GitHub App webhook URL/events, allowlist, health/ready gates, and rollback to `disabled`.
- **R2. Signed dry-run proof.** With rollout at `dry_run`, a signed allowlisted GitHub delivery (fixture or real) for an enabled agent enqueues exactly one execution; replay of the same delivery ID does not duplicate; disabled agents produce receipt-only evidence and no work.
- **R3. Action presets.** The agent editor exposes two presets: **Fix issue** (`fix_issue`) and **Resolve PR feedback** (`resolve_pr_feedback`). Selecting a preset sets pipeline expectations, default `skillId` (review skill for resolve; none/empty for fix-issue), suggested instructions stub, and which curated trigger families are appropriate.
- **R4. Preset ↔ trigger consistency.** Saving an agent fails closed when its action preset conflicts with its triggers (e.g. `fix_issue` with only pull-request triggers, or `resolve_pr_feedback` with only issue triggers). One primary action preset per agent in this phase.
- **R5. Template agents.** Operator can create a disabled agent from templates: **Issue opened → Fix issue** and **PR opened → Resolve PR feedback** (optionally also issue-edited / PR-synchronize variants). Templates prefill name, instructions stub, curated trigger, action preset, `dry_run` publication policy, and require an App-accessible repository selection before save.
- **R6. Versioned portable representation.** Copy-as-JSON includes the action preset (and template provenance if any) without secrets or raw webhook payloads. Existing agents without a preset remain loadable; export assigns a compatible default derived from `skillId`/triggers when possible, otherwise requires operator choice on next edit.
- **R7. Staged publish authority.** Advancing beyond `dry_run` requires explicit ops evidence. `approval_required` keeps publication confirmation semantics; `publish_allowed` is per-agent opt-in and still subject to allowlist, start-time auth, verification, exact-head, secret/patch policy, and branch-protection checks. No auto-merge; no PR approval authority.
- **R8. Unattended review side effects only when publish is true.** Resolve-PR-feedback runs may push commits and reply/resolve eligible review threads only when rollout stage and pinned `publicationPolicy` jointly allow publish. Dry-run review executions must not mutate remote PR state.
- **R9. Fleet-watch decommission criteria.** For at least one repository previously covered by `.agents-state/fleet-pr-watch.py`, an enabled Shipwright agent with webhook + action preset becomes the primary watcher. Document when the poller entry may be removed; do not delete the stopgap until R2 and R8 proofs exist for that repo.
- **R10. Operator evidence.** Configure → test → enable → trigger → history remains visible in the Agents/Operator consoles with redacted receipts, phase timeline, and no browser-held credentials. Browser proof at desktop and 390px for the happy path.
- **R11. Safety invariants unchanged.** Disabled-by-default agents, immutable revisions, host-owned credentials, emergency stop, idempotent deliveries, condition-only-narrows-eligibility, and dry-run-first defaults remain authoritative.
- **R12. Cost and security gate before `publish_allowed`.** Record td notes for cost ceiling, teardown, and security sign-off before any agent revision is set to `publish_allowed` on the remote pin.

## Scope boundaries

**In:** live rollout activation + dry-run proof; action presets; template agents for curated triggers; publish-stage criteria; fleet-watch decommission for covered repos; browser/remote proof; docs/runbook updates.

**Out:** Slack/MCP/tool marketplace; multi-tenant tenancy; arbitrary webhook/event DSL; JSON import; auto-merge; submitting PR approvals; persistent always-on agent compute; multi-repository agents; changed-file conditions; autonomous policy self-modification.

**Deferred:** richer action catalog beyond the two presets; assignee/reviewer condition fields; schedule-trigger templates; multi-preset agents; full retirement of fleet-pr-watch for every fleet repo in one change.

## Key decisions

- **Activate before inventing** — control-plane primitives exist; Phase 3 turns the key and makes actions obvious.
- **Two action presets, not a tool graph** — map directly onto existing issue and review pipelines.
- **Mode remains target-driven at execution** — presets constrain configuration; runtime still derives issue vs review from the GitHub target kind, then applies the pinned skill/policy.
- **Dry-run proof before publish** — no skip of staged rollout.
- **Fleet poller is a stopgap** — replace per covered repo after live proof, not by deleting the script first.
- **Keep human merge/approval authority** — Shipwright publishes PRs/commits/comment resolutions; humans merge and approve.

## Prior learnings applied

- Gap assessment `docs/brainstorms/2026-07-25-always-on-agents-gap-assessment.md` — ~70% built / ~30% live framing and Phase 3 unit sketch.
- Phase 2 plans — durable agents, leases, webhook idempotency, rollout stages.
- Automation trigger configuration — curated triggers, repo picker, disabled-by-default, Copy-as-JSON.
- Condition filtering — conditions narrow only; never grant publish authority.
- Deployment docs — `SHIPWRIGHT_ROLLOUT_STAGE` and webhook configuration contract.

## Open questions

- **Resolved for planning default:** persist `actionPreset` on the agent draft (versioned) rather than UI-only inference, so history and JSON stay explicit.
- **Resolved for planning default:** templates create local drafts only; they do not auto-enable or auto-advance rollout stage.
- **Deferred to plan/implementation:** exact default instructions text and whether issue-mode gains a named skillId later (not required for R3 if issue pipeline stays skill-less).
