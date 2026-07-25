---
date: 2026-07-25
topic: always-on-agents-gap-assessment
origin: operator goal + Cursor Automations "Review PR" UX reference
session: ses_bf9ac5
status: ready
next: docs/brainstorms/2026-07-25-always-on-watched-repo-automations-requirements.md
plan: docs/plans/2026-07-25-feat-always-on-watched-repo-automations-plan.md
td_epic: td-a4dc59
---

# Always-on remote agents: gap assessment

**Summary:** Shipwright already has most of the *control-plane and pipeline* pieces for Cursor-like automations (named agents, watched repos, curated PR/issue triggers, durable queue, Docker sandbox, issue→PR and PR-feedback workflows, operator console). The remaining distance is mostly **operational activation** (live rollout + webhook wiring) and a smaller **product slice** (named action presets, unattended publish with fail-closed gates, and retiring the local fleet-watch workaround). We are roughly **~70% capability-complete** and **~30% “always-on in production”**.

## Operator vision

Always-on service on a remote host that:

1. Watches selected repositories.
2. Fires on triggers such as **PR opened** or **issue opened**.
3. Selects an action such as **fix issue** or **resolve PR feedback**.
4. Spins an isolated workspace, applies the fix, runs verification.
5. Opens/updates a PR or pushes a commit, and resolves review comments when warranted.

Cursor Automations ("Review PR": inactive toggle, repo-from-trigger, instructions, tools, Slack, PR comment/approval) is the UX north star; Shipwright remains a single-operator, fail-closed service — not a multi-tenant SaaS clone.

## Scorecard

| Layer | Vision | Shipwright today | Distance |
| --- | --- | --- | --- |
| Always-on control plane | Remote process receives events 24/7 | systemd + Tailscale deploy; durable store; queue/scheduler exist | **Ops:** default `SHIPWRIGHT_ROLLOUT_STAGE=disabled`; worker idle until advanced |
| Watched repos | Picker over App-accessible repos | Owner-scoped allowlist + App catalog picker shipped | **Near done** for `dallascrilley/*` and `DallasCrilleyMarTech/*` |
| Triggers | PR/issue open (+ related) | Curated: issue created/edited, PR created, PR synchronize; schedule triggers; typed conditions | **Near done** in code; live webhook callback still operator-configured |
| Actions | Fix issue / resolve PR feedback / … | Two pipelines: issue→PR (`shipwright`) and PR review (`review-agent` + `fix-review-findings` skill) | **Partial:** skill registry has one review skill; no first-class action catalog UI |
| Isolated workspace | Dev container / sandbox | Disposable Docker via AgentOS + Pi; Bun verification runtime proven | **Done** (Docker sandbox ≠ VS Code Dev Containers; functionally equivalent for this goal) |
| Verify then publish | Independent verify; push/PR | Independent verify; patch/secret policy; exact-head; no force-push | **Done** in pipeline; unattended publish still gated by design |
| Resolve comments | Reply + resolve threads | Review pipeline replies/resolves with markers when `publish=true` | **Partial:** works on explicit/publish path; not proven as always-on trigger→publish loop |
| Operator UX | Cursor-like agent editor | Agents console + operator console (history, readiness, recovery, lineage) | **Close** on control/evidence; less marketplace/tools (Slack/MCP) chrome |
| Fleet coverage | Multi-repo always watching | Agents are per-repo; local `.agents-state/fleet-pr-watch.py` is a stopgap | **Gap:** replace poller with enabled agents + webhook |

**Overall:** foundation for the vision is on `main` (Phase 2 + trigger config + conditions + console depth all closed in td). The gap is **turning the key** safely, then a thin Phase 3 to make unattended actions obvious and proven.

## What already ships (code-complete on main)

Closed epics that map directly to the vision:

- `td-a9f0ff` Phase 2 Cursor Agents parity — durable agents, queue/leases, GitHub + schedule triggers, lifecycle, console, observability
- `td-c4c766` Automation repository and trigger configuration — App-accessible repo picker, curated triggers, safe JSON, dry-run-first
- `td-18bac8` Typed GitHub trigger condition filtering — actor/labels/base-branch/draft
- Operator console P0/P4 survivors (`td-f87a9b`, `td-459f83`) — evidence, recovery, history, readiness

Concrete primitives:

- **Agents:** name, repo scope, instructions, `skillId`, `publicationPolicy` ∈ `{dry_run, approval_required, publish_allowed}`, enable/disable, immutable revisions
- **Triggers:** `issue_created`, `issue_edited`, `pull_request_created`, `pull_request_pushed`, plus schedules
- **Ingress:** signed `POST /api/github/webhook` with delivery idempotency
- **Execution:** issue and review pipelines; host-held GitHub credentials; sandbox never sees App keys
- **Safety:** allowlist re-check at start; verify-before-publish; secret/patch limits; emergency stop / rollout stages

## Built but not “live always-on” yet

These are the largest practical gaps versus the vision — mostly configuration and proof, not greenfield engineering.

1. **Rollout stage defaults to `disabled`**  
   Until advanced to at least `dry_run`, triggers and the scheduler do not claim work. Stages: `disabled` → `test_only` → `dry_run` → `approval_required` → `publish_allowed`.

2. **GitHub App webhook callback**  
   Must be pointed at `https://<SHIPWRIGHT_PUBLIC_HOST>/api/github/webhook` with `GITHUB_WEBHOOK_SECRET`, Issues + Pull requests events. Inactive until configured.

3. **No sustained live proof of the full loop**  
   Desired proof: watched repo → curated trigger → queued execution → sandbox → receipt → (later) gated publish → PR/comment resolution, across restart and delivery replay.

4. **Local fleet PR watch remains the operational crutch**  
   `.agents-state/fleet-pr-watch.py` + handoff dispatch (e.g. vmix #190) show the *need* for always-on PR feedback resolution, but bypass the agent control plane.

5. **Publication policy stays conservative**  
   README still describes publish after explicit operator confirmation. `publish_allowed` exists but is the last rollout stage and still fail-closed on allowlist/auth/verify/exact-head/secrets. Unattended merge is out of scope and should stay out.

## Product gaps vs Cursor Automations UX

Worth closing in Phase 3, without chasing pixel parity:

| Cursor-shaped concept | Shipwright today | Gap |
| --- | --- | --- |
| Named automation ("Review PR") with inactive toggle | Agents console enable/disable | Mostly present; naming/presets thinner |
| Repository from Git trigger | Repo picker + trigger sentence | Present |
| Agent instructions | Required instructions on revision | Present |
| Tools row (Open PR, Memories, Slack, Comment on PR, MCP) | Host-owned GitHub mutations + skill projection; no Slack/MCP tool graph | **Defer** Slack/MCP marketplace; keep host-owned writes |
| Action: fix issue | Issue pipeline | Needs **action preset** wiring from trigger → issue mode |
| Action: resolve PR feedback | Review pipeline + `fix-review-findings` | Needs **action preset** + trigger defaults for PR events |
| Allow PR approval | Explicitly avoided | **Keep out of scope** (approval is human authority) |
| Run history | Durable history + lineage | Present |

Skill registry today: effectively **`fix-review-findings` only**. Issue runs do not use that skill model the same way. A small action/skill catalog would make “fix issue” vs “resolve PR feedback” first-class in the agent editor.

## Intentionally different (not gaps)

Do **not** treat these as missing work:

- Single-operator, not multi-tenant SaaS
- Control plane always-on; **worker compute ephemeral** (no persistent paid agent VM per automation)
- Credentials and thread mutations stay on the host
- No autonomous self-modification of agent policy
- No arbitrary user code / unrestricted HTTP triggers
- No auto-merge; publication ≠ merge authority

## Distance estimate

```text
Vision:  watched repos → trigger → sandbox fix → verified PR/comment resolve (always-on)

[████████████████░░░░] ~70% capability on main
[██████░░░░░░░░░░░░░░] ~30% always-on in production (rollout + webhook + live proof)

Remaining engineering: thin Phase 3 (presets + live activation + proof)
Remaining ops:          advance rollout stages with evidence at each step
```

Rough sequencing effort once Phase 3 is imported:

| Unit | Intent | Effort |
| --- | --- | --- |
| U1 | Live activation runbook + `test_only` / `dry_run` proof on pin | 3–5 pts |
| U2 | Action presets (`fix_issue`, `resolve_pr_feedback`) in agent editor | 5 pts |
| U3 | PR-opened / issue-opened default agent templates | 3 pts |
| U4 | Unattended `approval_required` → selective `publish_allowed` with security sign-off | 5–8 pts |
| U5 | Retire fleet-pr-watch stopgap for repos covered by enabled agents | 3 pts |
| U6 | End-to-end remote proof + browser evidence (desktop + 390px) | 3–5 pts |

## Recommended Phase 3 epic

**Title:** Phase 3 — Always-on watched-repo automations  

**Goal:** An operator can enable a disabled-by-default agent on an allowlisted repo with a curated trigger and action preset; a signed GitHub event produces one sandbox execution on the remote pin; dry-run is proven first; selective publish remains fail-closed; comment resolution works for the review action; the local fleet poller is no longer required for covered repos.

**Non-goals:** Cursor tool marketplace, Slack/MCP parity, auto-merge, multi-tenant tenancy, persistent always-on agent compute, PR approval authority.

### Proposed acceptance

1. Remote pin at `dry_run` (or higher) with webhook configured; signed fixture or real allowlisted event enqueues exactly one run; replay does not duplicate.
2. Agent editor offers action presets **Fix issue** and **Resolve PR feedback** that select the correct pipeline/skill defaults.
3. Creating from a “PR opened → resolve feedback” or “Issue opened → fix issue” template yields a disabled agent ready to test/enable.
4. At `approval_required` / selective `publish_allowed`, successful review runs push commits and resolve eligible threads without browser-held credentials; failures leave redacted receipts and no silent retry storms.
5. For at least one fleet repo, enabled Shipwright agents replace `.agents-state/fleet-pr-watch.py` as the primary watcher.
6. Browser proof of configure → test → enable → trigger → history at desktop and 390px; td cost/security notes before any `publish_allowed` agent.

### Suggested first requirements topics

- Live rollout activation checklist (secrets, webhook, stage gates, rollback)
- Action preset contract (mode + skillId + default verify policy + default publication policy)
- Template agents for the four curated GitHub trigger choices
- Publish-stage security criteria (what must be true before `publish_allowed`)
- Fleet-watch decommission criteria

## Current tracker / pin state (2026-07-25)

- `origin/main` @ `3b77985` — console survivors merged; **55/55 td issues closed**; no open/in_review work.
- Deploy docs still document rollout default **`disabled`**.
- Handoff from `ses_660e2a` still uses local fleet PR watch + manual remote-pin dispatch for review fixes — evidence that Phase 3 activation is the next product step, not more P4 console chrome.

## Sources

- `docs/plans/2026-07-21-shipwright-cursor-agents-parity-plan.md`
- `docs/plans/2026-07-21-shipwright-automation-agents-plan.md`
- `docs/plans/2026-07-22-feat-automation-trigger-configuration-plan.md`
- `docs/plans/2026-07-22-feat-github-trigger-condition-filtering-plan.md`
- `docs/deployment.md` (staged rollout + webhook)
- `ui/shared/agent-definition.ts` (`GITHUB_TRIGGER_CHOICES`, publication policies)
- `ui/server/skills.ts` (review skill registry)
- `.agents-state/handoff.md` (fleet watch stopgap)
