---
date: 2026-07-25
origin: docs/brainstorms/2026-07-25-always-on-watched-repo-automations-requirements.md
td_epic: td-a4dc59
status: proposed
---

# Always-on watched-repo automations plan (Phase 3)

Living document. Update Progress, Surprises & Discoveries, Decision Log, Outcomes & Retrospective, and Revision History whenever implementation stops or a decision changes.

**Summary:** Activate Shipwright's existing agent control plane on the remote pin, add first-class action presets and templates for Fix issue / Resolve PR feedback, prove signed dry-run triggers, then selectively advance publish authority and retire the local fleet PR poller for covered repos—without weakening host-owned credentials or fail-closed gates.

## Purpose / Big Picture

After this work, an operator can:

1. Follow a documented checklist to move production from `disabled` → `test_only` → `dry_run` with webhook wired.
2. Create a disabled agent from a template (issue→fix or PR→resolve feedback), pick an App-accessible repo, test, and enable.
3. Observe one idempotent sandbox execution from a signed GitHub event with redacted evidence.
4. Later, with security/cost notes, opt a specific agent into `publish_allowed` so review runs can push and resolve comments unattended under existing policy checks.
5. Stop relying on `.agents-state/fleet-pr-watch.py` for at least one covered fleet repo.

## Progress

- [x] (2026-07-25) Gap assessment written: `docs/brainstorms/2026-07-25-always-on-agents-gap-assessment.md`
- [x] (2026-07-25) Requirements R1–R12 written and grounded in current main
- [x] (2026-07-25) This plan drafted with U1–U6 sequencing
- [x] (2026-07-25) Import epic td-a4dc59 with U1-U6
- [x] (2026-07-25) U1 runbook written (`docs/runbooks/always-on-activation.md`); remote pin dry-run proof still open
- [x] (2026-07-25) U2 action presets landed on `feat/action-presets` (td-3bd33e); review/merge pending
- [ ] U3 Template agents
- [ ] U4 Publish-stage security criteria + selective `publish_allowed`
- [ ] U5 Fleet-watch decommission for one covered repo
- [ ] U6 End-to-end remote + browser proof


Imported units: U1=td-fae961 U2=td-3bd33e U3=td-a193a1 U4=td-912857 U5=td-eafee0 U6=td-7a6dc1

## Surprises & Discoveries

- Observation: Queue mode is already inferred from `target.kind` (`pull` → review). Action presets are primarily a configuration/UX contract plus save-time consistency checks, not a second runtime mode switch.
- Observation: Tracker was empty (55/55 closed) while ops still uses fleet-pr-watch — product gap is activation + presets, not missing Phase 2 primitives.
- Observation: Deploy default remains `SHIPWRIGHT_ROLLOUT_STAGE=disabled`; webhook is inactive until configured.

## Requirements

Trace to `docs/brainstorms/2026-07-25-always-on-watched-repo-automations-requirements.md`:

- R1 Live activation runbook
- R2 Signed dry-run proof
- R3 Action presets
- R4 Preset ↔ trigger consistency
- R5 Template agents
- R6 Versioned portable representation
- R7 Staged publish authority
- R8 Unattended review side effects only when publish is true
- R9 Fleet-watch decommission criteria
- R10 Operator evidence / browser proof
- R11 Safety invariants unchanged
- R12 Cost and security gate before `publish_allowed`

## Decision Log

- Decision: Persist `actionPreset` on the agent draft (`fix_issue` | `resolve_pr_feedback`) with export compatibility for legacy agents. Rationale: explicit history/JSON; avoid silent inference drift. Date/Author: 2026-07-25 / Cursor.
- Decision: Keep runtime mode derivation from target kind; presets constrain which triggers may be saved. Rationale: matches existing `queue-runner` bridge; smallest safe change. Date/Author: 2026-07-25 / Cursor.
- Decision: Sequence U1 (ops activation) in parallel-capable with U2 (presets) after import; U3 after U2; U4 after U1+U2; U5 after U1+U4 proof path; U6 last. Rationale: dry-run live proof unblocks confidence even before templates polish. Date/Author: 2026-07-25 / Cursor.
- Decision: No Slack/MCP/auto-merge/PR-approval in this phase. Rationale: gap assessment non-goals; preserve single-operator fail-closed model. Date/Author: 2026-07-25 / Cursor.

## Implementation units

### U1. Live activation runbook and dry-run proof

**Goal:** Make the remote pin receive and execute dry-run automations safely.

**Requirements:** R1, R2, R11

**Files:** `docs/deployment.md`, `deploy/shipwright.env.example`, optional `docs/runbooks/always-on-activation.md`, proof notes in this plan / td.

**Approach:**
1. Write a step checklist: secrets, webhook URL/events, allowlist, stage advance, health/ready, rollback.
2. Advance pin `disabled` → `test_only` → `dry_run` with evidence at each step.
3. Prove signed delivery → one queued/executed dry-run; replay idempotent; disable path leaves no work.

**Tests / proof:** deploy doctor; `/healthz`+`/readyz`; signed webhook fixture or real allowlisted event; metrics show stage; rollback restores `disabled`.

**Points:** 5

### U2. Action preset contract and editor

**Goal:** First-class Fix issue / Resolve PR feedback presets on agent draft + UI.

**Requirements:** R3, R4, R6, R11

**Files:** `ui/shared/agent-definition.ts`, `ui/shared/agent-management.ts`, `ui/server/agent-control-plane.ts`, `ui/app/components/operator/AgentManagementConsole.tsx`, focused specs.

**Approach:**
1. Add `actionPreset` enum to draft schema; default/migrate legacy agents.
2. Map presets → skill defaults and allowed curated trigger families.
3. Fail closed on inconsistent save; update Copy-as-JSON.
4. Surface preset picker in Agents console; keep instructions required.

**Tests:** schema round-trip; legacy load; inconsistent trigger rejected; export includes preset; UI selection sets skill defaults.

**Points:** 5

### U3. Template agents for curated triggers

**Goal:** One-click disabled drafts for the two primary automations.

**Requirements:** R5, R6, R10

**Files:** agent management shared helpers + Agents console create flow; specs.

**Approach:**
1. Offer templates: Issue opened → Fix issue; PR opened → Resolve PR feedback.
2. Prefill name, instructions stub, trigger, preset, `dry_run`; require repo selection.
3. Templates never auto-enable.

**Tests:** template draft shape; save still disabled; browser create path.

**Points:** 3

### U4. Publish-stage security criteria and selective publish_allowed

**Goal:** Define and enforce what must be true before unattended publish.

**Requirements:** R7, R8, R12, R11

**Files:** `docs/deployment.md` / security checklist; control-plane validation if needed; td cost/security notes; focused tests around `canPublishAtStage` + review dry-run non-mutation guarantees.

**Approach:**
1. Document checklist: dry-run proof, verify presets, allowlist, secret policy, exact-head, cost ceiling, teardown, security sign-off.
2. Keep double opt-in (stage + revision policy).
3. Prove review dry-run does not push/resolve; publish path may, under gates.

**Tests:** stage matrix; dry-run review mutation blocked; publish_allowed still fails closed on policy violations.

**Points:** 5

### U5. Fleet-watch decommission for one covered repo

**Goal:** Replace poller primary path for one fleet repo with an enabled agent.

**Requirements:** R9, R10

**Files:** `.agents-state/fleet-pr-watch.json` / handoff docs; agent config proof; runbook note.

**Approach:**
1. Choose one fleet repo with App access (prefer a low-risk candidate).
2. Enable resolve-PR-feedback (or fix-issue) agent after U1 proof.
3. Remove or mark that repo inactive in fleet-pr-watch only after webhook executions observed.
4. Leave script available for uncovered repos.

**Proof:** handoff updated; poller no longer primary for that slug; agent history shows triggered runs.

**Points:** 3

### U6. End-to-end remote and browser proof

**Goal:** Close the phase with desktop + 390px evidence and plan retrospective.

**Requirements:** R2, R8, R10, R12

**Files:** this plan Outcomes; screenshots/notes as needed; verify green.

**Approach:** configure → test → enable → trigger → history; capture receipts; confirm no secret leakage; update gap assessment distance.

**Points:** 3

## Sequencing

```text
U1 (activation) ──┐
                  ├──► U4 (publish criteria) ──► U5 (fleet decommission) ──► U6 (E2E proof)
U2 (presets) ─► U3 (templates) ─┘
```

U1 and U2 may proceed in parallel after import. U3 depends on U2. U4 depends on U1 and U2. U5 depends on U1 and U4. U6 depends on U3–U5 (or U1+U2 minimum if templates slip, with explicit note).

## Validation and acceptance

Matches requirements acceptance:

1. Remote pin at `dry_run`+ with webhook; one idempotent signed execution.
2. Action presets in editor with consistency checks.
3. Templates yield disabled ready-to-test agents.
4. Publish stages documented; selective `publish_allowed` fail-closed; review mutations only when publish true.
5. One fleet repo primary-watched by Shipwright agent.
6. Browser proof desktop + 390px; cost/security notes before publish_allowed.

## Out of scope

Slack/MCP marketplace, multi-tenant tenancy, auto-merge, PR approvals, arbitrary event DSL, JSON import, persistent always-on agent VMs, multi-repo agents, full fleet poller deletion in one shot.

## Revision History

- 2026-07-25: Initial Phase 3 plan from gap assessment + requirements (ses_bf9ac5).
