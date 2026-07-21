---
date: 2026-07-20
subject: Shipwright operator console capabilities and UI
focus: missing user-facing features and UI elements
mode: repo
axes: [execution visibility, change evidence, recovery and history, intake orchestration, operator safety]
candidates_generated: 20
survivors: 7
---

# Ideation: Shipwright operator console capabilities

**Subject & grounding:** Shipwright is a private, single-operator system that turns allowlisted GitHub issues into verified PRs; credentials remain host-side and publication requires an explicit second confirmation (`README.md:3-7`, `README.md:67-77`). Its console already combines durable run history, URL preflight, verification selection, phase status, and redacted receipt evidence in a three-column workflow (`ui/README.md:24-33`, `ui/app/components/operator/OperatorConsole.tsx:380-649`, `ui/app/components/operator/OperatorConsole.tsx:725-930`). The strongest gaps are not broader autonomy or tenancy; they are clearer operator evidence, recovery, and repeatability within the existing safety model.

**Cull summary:** Generated 20 candidates, kept 7. Cut 13 for: conflicting with the declared single-operator/non-autonomous model (multi-run queue and autonomous promotion), lower leverage than stronger evidence/recovery variants (SSE-only progress and generic notifications), redundant approaches to retry/history, or an insufficiently grounded user need (unbounded custom skill configuration).

## Ranked ideas

### 1. Redacted phase timeline
- **Axis:** Execution visibility
- **Basis:** `direct` — the P0 plan explicitly defers a `phaseLog` to P1, requiring server-authored, redacted, truncated templates rather than raw agent or provider output (`docs/plans/2026-07-20-feat-operator-console-p0-ux-plan.md:47`, `:203-205`). The current evidence panel has phase state and terminal receipt fields, but no historical sequence (`ui/app/components/operator/OperatorConsole.tsx:725-913`).
- **Why it matters:** A durable timeline answers the first operator question—what happened, and where did it stop—without weakening the existing secret-redaction boundary.
- **What exploring it looks like:** Define the minimal template vocabulary, retention/redaction contract, and which milestones are useful for both issue and review runs.

### 2. Reviewable change-evidence card before publication
- **Axis:** Change evidence and publish confidence
- **Basis:** `direct` — receipts expose changed-file names, verification outcome, branch, commit, and pinned head (`ui/app/components/operator/OperatorConsole.tsx:827-885`), while the publish sheet currently shows target, skill, verification command, and a warning that the agent reruns (`ui/app/components/operator/OperatorConsole.tsx:661-704`).
- **Why it matters:** The operator can confirm that a dry run passed but cannot efficiently judge the scope or risk of its resulting change before deciding to initiate a new publish run. A bounded, redacted evidence card would turn scattered fields into a deliberate publication decision.
- **What exploring it looks like:** Decide which durable, secret-safe diff summary or policy-derived risk indicators are trustworthy enough to display as prior-run context without implying an in-place promotion.

### 3. Target-aware verification presets
- **Axis:** Intake orchestration
- **Basis:** `direct` — the console defaults to `bun test` and allows a raw Advanced override (`ui/app/components/operator/OperatorConsole.tsx:511-589`); the original preset design explicitly allows an optional repository glob (`docs/plans/2026-07-20-feat-operator-console-p0-ux-plan.md:43`), but the current UI offers static choices.
- **Why it matters:** For an allowlisted fleet of repositories, selecting the wrong verification command creates avoidable dry-run failures. Server-owned, target-aware defaults preserve the safe preset-first posture while making a pasted URL more likely to work on the first attempt.
- **What exploring it looks like:** Establish matching precedence, an unmatched-repository fallback, and the UI explanation that makes a selected preset auditable rather than magical.

### 4. Run recovery cockpit for refreshes and restarts
- **Axis:** Recovery and history
- **Basis:** `direct` — run records persist across refreshes and service restarts, while genuinely unfinished runs are marked interrupted (`README.md:77`, `ui/README.md:43`). The UI history is selectable but starts with no selected run (`ui/app/components/operator/OperatorConsole.tsx:388-430`, `:745-753`), and generic next actions are the principal recovery mechanism (`ui/app/components/operator/OperatorConsole.tsx:756-800`).
- **Why it matters:** An operator should not have to reconstruct an interrupted or active operation from a history list after refreshing the browser or after a host restart. Explicit recovery state keeps the service trustworthy at the exact moments it is least convenient.
- **What exploring it looks like:** Specify which latest states auto-reopen, how restart interruption differs from an agent/verification failure, and the retry guardrails for each.

### 5. Linked run lineage and history-to-intake replay
- **Axis:** Recovery and history
- **Basis:** `direct` — retries and publish runs can start from `fromRunId` (`ui/README.md:26-33`), but the history rail displays a flat target/status/run-ID list (`ui/app/components/operator/OperatorConsole.tsx:394-428`) and selecting a row only changes evidence selection (`ui/app/components/operator/OperatorConsole.tsx:398-401`).
- **Why it matters:** A dry-run → retry → publish chain is operationally one decision sequence, yet it currently looks like unrelated records. Visible parentage and intentional form hydration would make successful patterns and failed retries reusable without copying values by hand.
- **What exploring it looks like:** Define the lineage record, the distinction between “load as draft” and “retry now,” and how the UI prevents a historical dry run from looking publishable in place.

### 6. Searchable, retained run-history navigator
- **Axis:** Recovery and history
- **Basis:** `direct` — the registry returns newest-first records with a default 50-record limit (`ui/server/operator-runs.ts:346-349`), whereas the UI renders an unfiltered, scrollable flat list (`ui/app/components/operator/OperatorConsole.tsx:381-430`). Records are persisted atomically as a JSON store (`ui/server/operator-runs.ts:88-113`).
- **Why it matters:** Durable history ceases to be useful once recurring work across repositories and targets pushes relevant attempts out of the first page. Target, status, and date filters—paired with an explicit retention view—would preserve traceability without turning the product into a multi-user dashboard.
- **What exploring it looks like:** Choose lightweight server filtering/pagination and a retention policy that preserves audit needs while bounding disk growth and stale data.

### 7. Non-secret host readiness panel
- **Axis:** Operator safety
- **Basis:** `direct` — successful operation depends on configured model and least-privileged GitHub App credentials plus Docker/toolchain prerequisites (`README.md:11-24`), but the console header only distinguishes Demo from Live (`ui/app/components/operator/OperatorConsole.tsx:369-377`) before a run fails.
- **Why it matters:** Operators currently learn that a host dependency is unavailable only after attempting a run. A small, non-secret readiness panel can surface whether the configured provider, GitHub App configuration, sandbox runtime, and state store pass safe health checks—without exposing credentials or adding configuration controls to the browser.
- **What exploring it looks like:** Define a redacted health contract, refresh cadence, failure disclosures, and the exact difference between “not configured,” “unreachable,” and “ready.”

## Competitive reference: Cursor Automations

**Observed in Chrome on 2026-07-20:** Cursor frames automation as a lightweight operations console, not a generic agent chat. Its index starts with two compact seven-day KPIs (total runs and success rate), then a Mine/Team switch, search, and a scan-friendly table with automation name, author, creation date, active/inactive state, connected tools, and overflow actions.

The detail view makes a workflow legible without opening its implementation: name and enabled state, repository, branch, execution environment, author, editable GitHub trigger, and explicit agent instructions. A separate Run History provides search and filtering, 24-hour and seven-day success/failure counts, individual trigger payloads, tool usage, status, duration, pagination, and an emergency **Stop All Runs** control. It also exposes **Test run** before a configuration save.

### Parity targets worth adopting

1. **Operate from summaries, investigate from evidence.** Add compact run outcome aggregates and target/status filtering to Shipwright history; retain the current receipt as the deeper evidence surface.
2. **Make each run profile self-explanatory and operable.** Surface the selected target, trigger, verification policy, run mode, and enabled state together. Adapt Cursor's repository/environment header into a persistent cloud-automation profile with explicit enable/disable controls.
3. **Separate configuration from execution history.** Keep the intake/publish form focused on the next request; make historical attempts searchable and show terminal status, duration, verification result, and parent/retry lineage.
4. **Treat dry runs as first-class operator tests.** Preserve Shipwright's explicit publish confirmation, but make a dry-run's scope, verification selection, and result easy to inspect and intentionally reuse.
5. **Favor dense, quiet scanability.** Cursor's dark, single-table layout and small KPI cards make routine health legible before details; Shipwright should prefer these bounded summaries over a chat-like activity feed.

### Target operating model

Shipwright's intended end state is **always-on cloud agents** with explicit automation enable/disable controls. Safety should come from scoped credentials, allowlists, policy-gated write actions, auditable receipts, and emergency stop controls—not from ruling out autonomous execution. The open product-design work is to define which actions may run unattended and which remain confirmation-gated.
