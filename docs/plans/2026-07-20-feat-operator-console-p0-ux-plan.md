---
date: 2026-07-20
origin: session operator-console UX design (post demo-video + pipeline-true CTA review)
td_epic: td-837e4a
supersedes_partial: docs/plans/2026-07-20-feat-operator-evidence-safety-console-plan.md
---

# Operator console P0 UX (task-oriented cockpit)

**Summary:** Keep the existing three-column operator console, but make it task-oriented: human-readable history, paste-and-go launch, one primary next action per run state, server-owned verify presets and skill ids (no durable host paths), and pipeline-true publish behavior (new publish run from dry-run inputs — never in-place promote).

## Prior / overlapping work

`docs/plans/2026-07-20-feat-operator-evidence-safety-console-plan.md` (epic `td-f87a9b`) already delivered or specified:

- Failure `errorMessage` + `errorCode` on receipts
- Expanded `redactSecrets` / secret-like patch policy
- Cancel via `AbortSignal` (`ui/actions/cancel-shipwright-run.ts`)
- Durable history list (`list-shipwright-runs`) + console history rail
- Review mode through the same registry (still uses browser-supplied `skillPath`)
- Verify log tails, provider/model chips, 30m default timeout

**This plan does not re-implement those units.** It starts from the current console on `main` and closes the remaining P0 UX gaps. Where the older plan’s R8 still requires absolute `skillPath` in the request, this plan **replaces** that contract with `skillId` + server resolution (see Key technical decisions).

## Requirements

- R1. History rows are scannable without run ids: show `owner/repo`, `#number`, title when known, status, duration, and a one-line summary.
- R2. Every terminal run surfaces exactly one primary next action appropriate to state; running shows Cancel only as primary.
- R3. Dry-run success primary CTA is **Start publish run (same inputs)** — starts a **new** publish run via confirm sheet. It must not imply in-place promotion of dry-run workspace output. UI must show prior pinned head SHA (when known) and copy that a new publish run **reruns the agent**, may produce a different diff, and will re-authorize + re-verify before publish.
- R4. Default launch path is paste-and-go: one GitHub issue/PR URL field, auto mode detect, primary **Dry run**, secondary **Publish…** (existing confirm sheet). Timeout and raw overrides live under Advanced.
- R5. Verify commands default to **server-owned named presets**. Raw `verifyCommand` is Advanced only, authenticated operator path, validated (non-empty, length-capped, reject obvious shell metachar chains if a simple allowlist is practical; at minimum reject empty/control chars). Prefer preset id on the wire.
- R6. Review skills use **`skillId`** (e.g. `fix-review-findings`). Server resolves path, reads content, computes hash. Durable `OperatorRunRecord.request` persists `skillId` (+ receipt already has `skillSha256`) and **must not** persist absolute host `skillPath`. History/diagnostics/export must not echo filesystem layout.
- R7. Optional thin `resolve-target` preflight returns only necessary metadata + pinned snapshot (kind, owner, repo, number, title?, allowed, denyReason?, pinned.headSha?, pinned.openThreadCount?) — not a broad GitHub mirror.
- R8. Failed runs show playbook UI: short cause from `errorCode`/`errorMessage`/`operatorHint`, optional log tails (already present), and CTA bound to next action (retry dry-run, edit verify & retry, fix target).
- R9. Demo vs live is visible (badge/strip) so operators never mistake `SHIPWRIGHT_UI_DEMO=1` for production.
- R10. Existing cancel, publish double-confirm, receipt redaction, and single-active-run registry invariants remain intact.

## Key technical decisions

- **Keep three-column layout.** Change density and decisions, not IA chrome. Files: `ui/app/components/operator/OperatorConsole.tsx` primary UI surface.
- **No in-place dry-run → publish.** `src/pipeline/run.ts` only commit/push/opens PR inside `if (request.publish)`. Dry-run workspaces are not promotable artifacts. CTA clones request fields into a new start with `publish: true` + confirm. Trust copy is mandatory (R3).
- **Replace durable `skillPath` with `skillId`.** Older plan R8 allowed operator-supplied absolute paths in the request. That leaks host layout through history APIs. New schema: `skillId` required for review in the normal path; server map (env or config) e.g. `SHIPWRIGHT_SKILL_FIX_REVIEW_FINDINGS` or a small registry in `ui/server/skills.ts`. CLI may keep `--skill` path; console/API must not store it on records. Migration: when loading old records that only have `skillPath`, display skill as `custom` / omit path from UI; do not round-trip path into new starts.
- **Presets over free-form verify.** Ship a small server registry (`ui/server/verify-presets.ts`): id, label, command, optional repo glob. Request accepts `presetId?: string` and optional advanced `verifyCommand`. If `presetId` set, server expands command. Persist on record: `presetId` + resolved `verifyCommand` (command is already what the sandbox runs; preset id is the operator intent). Raw command without preset allowed only when Advanced validation passes.
- **Next-action helper is pure and shared.** Implement `resolveOperatorNextAction(record): { primary, secondary[] }` in `ui/shared/operator-run.ts` (or sibling) so UI and tests share one matrix. No LLM.
- **Target metadata is additive on the record**, not only derived in the client. Parse URL at start into `target: { kind, owner, repo, number, url, title? }`. Title/head from `resolve-target` when available; URL parse alone is enough for history scannability if preflight deferred.
- **`fromRunId` retry** clones stored request (normalized, without publishConfirmed), applies overrides (`publish`, `presetId`, `verifyCommand`), starts new run. Does not resume old workspace.
- **`phaseLog` is deferred (P1)** if attempted at all: summaries must be server-authored templates, redacted/truncated, never raw agent/provider output (durable JSON store leakage). Not required for P0 acceptance.
- **`operatorHint`** optional short string set by registry on known failure codes; safe static map, not model text.

## Implementation units

### U1. Shared run view model (target, summary, next action)

- **Goal:** Records carry scannable metadata; one pure function decides the primary CTA.
- **Requirements:** R1, R2, R3, R8
- **Files:**
  - `ui/shared/operator-run.ts`
  - `ui/shared/operator-run.spec.ts`
  - `ui/server/operator-runs.ts` (populate target/summary/duration on start/complete)
  - `ui/server/operator-runs.spec.ts`
- **Approach:**
  - Extend `OperatorRunRecord` with optional `target`, `summary`, `durationMs`, `finishedAt?`, `operatorHint?`.
  - Parse GitHub URL into target at `start`.
  - On terminal transition, set `finishedAt`, `durationMs`, and `summary` from receipt (e.g. `verify passed · 2 files`, `verify failed (exit 1)`, `cancelled`, `agent_failed`).
  - Add `resolveOperatorNextAction(record)` covering: running→cancel; dry success→start publish run (same inputs); published success→open PR; verify fail→edit verify & retry dry; other fail→retry dry / fix target; review complete extras as secondary open PR/threads.
  - Document in code comment that dry success does **not** promote workspace output.
- **Tests:**
  - URL parse: issue and PR canonical forms → target fields.
  - Next-action matrix table for each status/phase/publish combination including dry-run success ≠ promote.
  - Summary generation for succeeded verify / failed verify / cancelled.
  - Old records without target still don’t throw (client falls back to `targetUrl(request)`).
- **Verification:** `cd ui && pnpm exec vitest run shared/operator-run.spec.ts server/operator-runs.spec.ts`

### U2. skillId registry + durable request normalization

- **Goal:** Review runs never persist host filesystem paths.
- **Requirements:** R6
- **Files:**
  - `ui/server/skills.ts` (new)
  - `ui/shared/operator-run.ts` (schema: `skillId` optional/default; stop requiring `skillPath`; reject persisting path)
  - `ui/server/operator-runs.ts` (resolve skillId → path only in-memory for `createReviewPipelineDependencies`; normalizeRecord + startup reconcile)
  - `ui/shared/operator-run.spec.ts`, `ui/server/operator-runs.spec.ts`
  - `ui/README.md` (document skillId + env map)
- **Approach:**
  - Default skill id `fix-review-findings`.
  - Resolution order: explicit env path for that id → well-known hub artifact path if present → error with operatorHint.
  - Stored request shape after normalize: `{ mode, issueUrl|pullRequestUrl, skillId?, presetId?, verifyCommand, publish, timeoutMinutes }` — **no skillPath**.
  - **On-disk sanitization, not response-only filtering:** `normalizeRecord` (load path) and registry startup reconciliation must strip `skillPath` from legacy records, map to `skillId` when basename/path matches a known skill, mark unmapped legacy review records view-only (`operatorHint` like “re-run required: legacy skill path removed”), and **write the sanitized record back** to the JSON store. A store-level test asserts raw file contents after load/start do not contain absolute skill path strings for new or reconciled records.
  - `fromRunId` must clone only the normalized request: never copy `skillPath`; if legacy source cannot resolve `skillId`, fail with a clear hint to start a fresh review run.
  - CLI path entrypoint unchanged (CLI does not use the operator JSON store contract).
- **Tests:**
  - Review start with `skillId` succeeds in demo without skillPath.
  - Persisted record JSON (on disk) has no `skillPath` key after start.
  - Legacy record on disk is rewritten without absolute skill path after registry load/reconcile.
  - `fromRunId` from a legacy path-only record does not re-persist `skillPath` (either maps skillId or errors).
  - Unknown skillId fails fast with clear errorCode/hint.
- **Verification:** `cd ui && pnpm exec vitest run shared/operator-run.spec.ts server/operator-runs.spec.ts`

### U3. Verify presets + Advanced raw command gate

- **Goal:** Common verify commands are one click; raw override is explicit and constrained.
- **Requirements:** R5
- **Files:**
  - `ui/server/verify-presets.ts` (new)
  - `ui/actions/list-verify-presets.ts` (new, read-only)
  - `ui/shared/operator-run.ts` (optional `presetId`)
  - `ui/server/operator-runs.ts` (expand preset at start)
  - specs for preset expansion + rejection of empty/control-char commands
- **Approach:**
  - Ship built-in presets: at least `bun-test` → `bun test`, and one longer example used in demos.
  - `list-verify-presets` returns `{ id, label, command }[]` (command visible to operator is OK; these are not secrets).
  - Start: if `presetId` provided, set verifyCommand from registry (ignore client command or require match).
  - Advanced raw: allow only if `presetId` absent; validate length 1–500, no NUL, trim; optional deny `` ` ``, `$(`, newlines if low false-positive.
- **Tests:**
  - preset expansion wins over mismatched client command.
  - unknown presetId fails.
  - raw empty/control rejected.
- **Verification:** `cd ui && pnpm exec vitest run shared/operator-run.spec.ts server/operator-runs.spec.ts`

### U4. fromRunId retry / republish start path

- **Goal:** One-click retry dry-run and start-publish-from-prior-inputs without retyping.
- **Requirements:** R2, R3, R8
- **Files:**
  - `ui/shared/operator-run.ts` (schema: optional `fromRunId`, mutual consistency rules)
  - `ui/server/operator-runs.ts` (`start` clone logic)
  - `ui/server/operator-runs.spec.ts`
- **Approach:**
  - `fromRunId` loads prior record; base request = normalized prior request; apply overrides (`publish`, `publishConfirmed`, `presetId`, `verifyCommand`, `timeoutMinutes`).
  - Always new `runId`. Never reuse sandbox/worktree.
  - Publish still requires `publishConfirmed` when `publish: true` (existing sheet / needsApproval).
  - When cloning dry success → publish, copy prior `receipt.baseSha` / target into UI messaging only (not a promote gate unless preflight exists).
  - Never clone legacy `skillPath`; depends on U2 normalize.
- **Tests:**
  - clone dry → new dry preserves target + preset/command.
  - clone dry → publish requires confirmation flag.
  - missing fromRunId errors.
  - does not copy skillPath from legacy records.
- **Verification:** `cd ui && pnpm exec vitest run server/operator-runs.spec.ts shared/operator-run.spec.ts`

### U5. OperatorConsole task-oriented UI

- **Goal:** Operators get paste-and-go, readable history, headline + one primary CTA, Advanced overrides, demo badge.
- **Requirements:** R1–R5, R8–R10
- **Files:**
  - `ui/app/components/operator/OperatorConsole.tsx`
  - optionally small presentational helpers colocated under `ui/app/components/operator/`
  - `ui/README.md` (operator UX notes)
- **Approach:**
  - **History:** render target title/repo/#, status, duration, summary; keep runId copyable secondary.
  - **Spec:** default URL field with mode auto-detect (issue vs pull path); buttons Dry run / Publish…; Advanced disclosure for timeout, preset select, raw verify, skillId (not path).
  - **Evidence:** status headline from next-action helper + receipt; single primary button; secondaries; collapse mono evidence and log tails under detail.
  - Wire primary actions to cancel / start(fromRunId) / open URL.
  - Dry-run success primary CTA label **Start publish run (same inputs)** with visible caveat: new run reruns agent, may differ, shows prior pinned SHA when known, re-authorizes and re-verifies — not in-place promote.
  - Demo badge via server-provided `demoMode` on list/get or tiny meta endpoint.
  - Preserve publish confirm Sheet behavior. **Demo publish is not a fake promote and must not mint fake PR URL/SHA that look live.** Prefer **friendly denial** after confirm (“Demo supports dry-run only; start a live publish run outside demo”) so the CTA path is exercisable through the sheet without lying about publication. Optional later: demo-only simulated receipt clearly labeled `execution.runtime: "demo"` with `pullRequestUrl` omitted and summary `demo publish not available` — never a plausible github.com PR link.
- **Tests:** Prefer component-level if harness exists; otherwise shared next-action tests + manual checklist. Add lightweight test for mode auto-detect pure helper if extracted.
- **Verification:** `cd ui && pnpm exec vitest run shared/operator-run.spec.ts` and manual demo-mode checklist in Validation.

### U6. Thin resolve-target preflight (optional but recommended in same PR if small)

- **Goal:** Block obvious deny/bad URLs before burning a run; pin head/title for history.
- **Requirements:** R7, R1
- **Files:**
  - `ui/actions/resolve-target.ts` (new)
  - `ui/server/resolve-target.ts` (new)
  - `ui/server/resolve-target.spec.ts`
  - wire title into record.target when start follows preflight (client passes title optional **or** server re-fetches once at start)
- **Approach:**
  - Parse URL first (no network).
  - If live mode and GitHub app configured, fetch only: issue/PR title, state, head SHA (PR), and unresolved thread count (PR) as needed.
  - Return pinned snapshot fields only. On demo mode, return parse-only + `allowed: true` fake pin.
  - Do not store raw GitHub payloads.
- **Tests:** parse-only cases; demo short-circuit; live path mocked Octokit if existing test doubles allow — otherwise unit-test pure parser and demo branch only.
- **Verification:** `cd ui && pnpm exec vitest run server/resolve-target.spec.ts shared/operator-run.spec.ts`

## Worktree & concurrency

- **worktree_slug:** `feat/operator-console-p0-ux`
- **spine_owner:** self
- **Pre-flight:** create worktree from clean `main` before edits; surfaces below are exclusive to this plan.
- **Active conflicts:** none known with open hub worktrees; shipwright `main` clean at plan authoring.

### Write surfaces

- U1: `ui/shared/operator-run.ts`, `ui/shared/operator-run.spec.ts`, `ui/server/operator-runs.ts`, `ui/server/operator-runs.spec.ts`
- U2: `ui/server/skills.ts`, schema + registry + README
- U3: `ui/server/verify-presets.ts`, `ui/actions/list-verify-presets.ts`, schema + registry
- U4: schema + `operator-runs.ts` start clone
- U5: `OperatorConsole.tsx`, README
- U6: `resolve-target` action/server (optional same PR)

## Prior learnings applied

- No `docs/solutions/` tree in this repo yet; apply in-repo receipt discipline from the evidence/safety plan:
  - Reuse `redactSecrets` for any new persisted strings (`summary`, `operatorHint` sources).
  - Do not introduce a second secret pattern list.
- Pipeline truth from `src/pipeline/run.ts`: publish gated on request flag at start — no fake promote CTA.
- Older console plan’s skillPath-in-request decision is **explicitly overturned** here for durable metadata safety.

## Deferred / out of scope

- In-place promotable dry-run artifacts / workspace resume
- `phaseLog` timeline summaries (P1; redaction rules already decided if added later)
- SSE progress (polling remains)
- Multi-operator tenancy
- Chat-as-primary operator surface
- Raising console timeout max to 120
- Changing CLI `--skill` path UX
- Visual redesign / new design system
- Broad GitHub sync or issue search

## Open questions

None blocking. Defaults locked:

- Default skillId: `fix-review-findings`
- Default preset: `bun-test`
- U6 may ship in the same PR if mocked tests stay fast; otherwise immediately after U5 in the same epic.

## Validation and acceptance

Automated:

```bash
cd /Users/dallascrilley/Documents/shipwright
bun test test/pipeline/receipt.test.ts  # no regression if touched
cd ui && pnpm exec vitest run shared/operator-run.spec.ts server/operator-runs.spec.ts
cd ui && pnpm typecheck
```

If U6 present: `pnpm exec vitest run server/resolve-target.spec.ts`.

Manual (demo mode):

```bash
cd ui && SHIPWRIGHT_UI_DEMO=1 SHIPWRIGHT_STATE_DIR=/tmp/shipwright-p0-ux pnpm dev
# or production preview on a free port
```

Checklist:

1. History shows repo/#/summary after a run — not hash-first.
2. Paste issue URL → Dry run → headline + primary **Start publish run (same inputs)** with SHA/rerun caveat visible.
3. That CTA opens confirm sheet and starts a **new** run id with publish=true (still demo-blocked from real publish if demo forbids publish — demo today throws on publish; in demo, assert CTA routes to confirm and server error message is clear, or allow demo publish flag only in tests).
4. **Demo publish note:** `executeDemo` currently throws on `publish`. P0 still shows **Start publish run (same inputs)** → confirm sheet; demo must **friendly-deny** after confirm (clear operator message). Do **not** mint fake live PR URLs/SHAs. Optional later: explicitly labeled demo-only non-published receipt without github.com links.
5. Review mode: select skillId, no absolute path field in default UI; persisted record has skillId/hash only.
6. Preset chip sets verify command; Advanced raw still works when allowed.
7. Failed verify (force via future demo hook or unit-level next-action) shows edit-verify retry CTA.
8. Cancel still works on in-flight demo run.
9. Demo/Live badge correct under `SHIPWRIGHT_UI_DEMO=1`.

## Idempotence and recovery

- Most units are additive on record schema (`target`, `summary`, `durationMs`, `skillId`, `presetId`); old records remain loadable.
- **U2 is an intentional non-additive migration:** legacy `skillPath` is stripped and rewritten on disk during load/reconcile. That is irreversible host-path removal by design; unmapped legacy review records become view-only with an operatorHint to re-run.
- Feature flag not required; new optional fields default safely.
- Rollback: revert PR code; already-sanitized stores will lack `skillPath` (safe). New fields remain ignorable by older UI if optional.

## Interfaces and Dependencies

Primary types live in `ui/shared/operator-run.ts`.

```ts
// Additive record fields (illustrative)
target?: {
  kind: "issue" | "pull";
  owner: string;
  repo: string;
  number: number;
  url: string;
  title?: string;
};
summary?: string;
durationMs?: number;
finishedAt?: string;
operatorHint?: string;

// Request (normalized durable)
mode: "issue" | "review";
issueUrl?: string;
pullRequestUrl?: string;
skillId?: string;          // review; no skillPath on disk records
presetId?: string;
verifyCommand: string;     // resolved command actually run
publish: boolean;
timeoutMinutes: number;
fromRunId?: string;        // start-only, not persisted on the new record as required field
```

Server-only resolution:

- `resolveSkill(skillId): { path, id }` internal
- `resolvePreset(presetId): { id, command, label }`

Actions:

- existing: `start-shipwright-run`, `get-shipwright-run`, `list-shipwright-runs`, `cancel-shipwright-run`
- new: `list-verify-presets`, optional `resolve-target`

## Progress

- [x] (2026-07-20) Plan authored from live console + pipeline review.
- [x] U1 shared view model
- [x] U2 skillId normalization
- [x] U3 verify presets
- [x] U4 fromRunId
- [x] U5 OperatorConsole UI
- [ ] U6 resolve-target (optional same epic)
- [ ] Validation checklist green

## Surprises & Discoveries

- Observation: Cancel, history list, review mode, and error tails already exist on main from the evidence/safety work. Evidence: `ui/actions/cancel-shipwright-run.ts`, `list-shipwright-runs.ts`, review branch in `operator-runs.ts`.
- Observation: Demo executor rejects publish, so publish CTA must gain a demo simulation or friendly denial — otherwise P0 acceptance cannot click-through publish. Evidence: `executeDemo` `if (request.publish) throw`.
- Observation: Dry-run cannot be promoted; publish is start-time flag in `src/pipeline/run.ts`.

## Decision Log

- Decision: Overturn durable `skillPath` in console records in favor of `skillId` + hash. Rationale: path is host layout leakage via history APIs; older plan R8 insufficient. Date: 2026-07-20.
- Decision: Dry-run success CTA starts a new publish run with explicit rerun/SHA caveat; no promote-in-place. Rationale: pipeline truth. Date: 2026-07-20.
- Decision: Demo publish = **friendly denial** after confirm (no fake PR URL/SHA). Rationale: must not lie about publication or invent promotable artifacts; CTA/sheet still exercisable. Date: 2026-07-20.
- Decision: Presets are server-owned; raw verify is Advanced. Rationale: command injection / foot-gun surface. Date: 2026-07-20.

## Outcomes & Retrospective

_Pending implementation._

## Revision History

- 2026-07-20: Initial P0 UX plan from operator-console design thread; scoped against existing evidence/safety plan and current `main` actions/registry.
