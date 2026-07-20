---
date: 2026-07-20
origin: td-f87a9b (2026-07-20 high-impact operator brainstorm import)
td_epic: td-f87a9b
---

# Shipwright operator evidence, safety, and console depth

**Summary:** Make failed runs legible, tighten secret handling before publication, add cancel and durable history in the operator console, then expose the existing review-agent path through that console. Keep issue-to-PR behavior stable and credentials host-side.

## Requirements

- R1. Failed issue and review runs persist a concise human-readable `errorMessage` on the receipt while preserving `errorCode`; the operator console shows that message for failed records. (td-b4d2ee)
- R2. Receipt and review-receipt redaction strips common model API key shapes (`sk-`, `sk-ant-`, `sk-or-`, `Bearer …`) plus existing GitHub/JWT/PEM/credential-URL patterns without wrecking ordinary prose, SHAs, or provider/model fields. (td-b90e24)
- R3. Publication policy rejects patches that embed private keys or high-confidence token patterns before commit/push; issue-to-PR and review pipelines both invoke the check; clean fixture patches still pass. (td-c81000)
- R4. The operator console can cancel an in-flight run via `AbortSignal`; the registry owns one `AbortController` per active run; cancel ends the record terminal with a durable cancelled/interrupted receipt and does not leave a zombie agent; a new start is allowed after cancel. (td-02ef5d)
- R5. Console timeout default matches CLI (`30` minutes); active/completed evidence surfaces `execution.provider` and `execution.model` without breaking `OperatorRunRecord` consumers. (td-8db3ce)
- R6. Verification results include size-capped stdout/stderr tails on the receipt; secrets still pass through `redactSecrets`; the console shows tails for failed verification (directly or behind disclosure). (td-cdbc57)
- R7. Durable run history is listable and reopenable in the console after refresh; selecting a prior terminal run loads receipt evidence without starting a new run; list is bounded and newest-first; demo mode still works. (td-894653)
- R8. Operator console can dry-run and (with second confirmation) publish the review-agent workflow for a same-repo PR URL + skill path + verify command; review receipts land under review-receipts; skill body and credentials stay off the wire; issue-to-PR mode remains unchanged. (td-ca269b)
- R9. Deployment docs state Tailscale as the primary operator/SSH path and that public SSH may be denied by design (empty public firewall). (td-2aa807)
- R10. Retire the `programming-agent` package script alias (delete or one-release hard deprecation); `bun run shipwright` remains the documented entrypoint. (td-a28c36)

## Key technical decisions

- **Persist `errorMessage` on receipts, keep registry `message`.** Catch paths already construct `PipelineError` with a message; write `receipt.errorMessage = redactSecrets(pipelineError.message)` (and the same for review receipts) before `writeReceipt`. Console prefers `receipt.errorMessage`, falls back to `record.message`. This makes CLI and restart-reconciled receipts self-describing without relying only on in-memory registry text.
- **Share secret detectors from `src/pipeline/receipt.ts`.** Expand `TOKEN_PATTERNS` used by `redactSecrets`, and export a `containsSecretLikeContent(text: string): boolean` (or equivalent) built from the same pattern set for policy. Do not duplicate regexes in `policy.ts`. Review receipts already call `redactSecrets` via `writeReviewReceipt`.
- **Policy scans patch text, not only paths.** Extend `assertPublishableChange` to accept the existing `patch` string from `inspectChanges()` (call sites already pass the full change summary with `patch` / `patchBytes`). On match, throw a clear `publication blocked: …` message. High-confidence patterns only — same set as redaction — to limit false positives.
- **Cancel uses failed terminal status + cancellation code, not a new status enum.** `OperatorRunStatus` stays `queued | running | succeeded | failed` to avoid a schema break. Cancel aborts the controller; pipeline abort points already throw; registry maps abort to `status: "failed"`, `message`/`errorMessage` describing cancellation, and `errorCode` such as `cancelled` or phase-specific `*_failed` from the existing abort path. UI shows Cancel only while non-terminal.
- **Verify port returns tails; receipt field is optional additive.** Widen `WorkspacePort.verify` to return `{ exitCode, stdoutTail?, stderrTail? }` (or full `ProcessRunResponse` sliced by the pipeline). Cap each tail at 8 KiB (last bytes/chars). Store on `receipt.verification` as optional `stdoutTail` / `stderrTail`. Sandbox already has stdout/stderr on `ProcessRunResponse`; only the port typing currently discards them.
- **History is registry `list()` + one list action; console keeps selected `runId`.** `JsonFileOperatorRunStore` already persists all records. Add `list({ limit })` newest-first on the registry, a read-only `list-shipwright-runs` action, and a history rail in `OperatorConsole`. Bound default to last 50.
- **Review console reuses cancel + history seams.** Do not invent a second run registry. Extend request schema with a mode (`issue` | `review`) or a parallel validated request union; review execution calls `createReviewPipelineDependencies` / `runReviewAgent` and writes under `review-receipts`. Skill path is a server-side absolute path string in the request (operator-supplied), never the skill body. Publish still requires second confirmation.
- **Timeout UI default 30; keep console max 60.** CLI allows 1–120; console schema currently max 60. Align default only (R5). Raising console max to 120 is deferred unless an operator need appears.
- **Alias removal is hard delete.** Repo references are only `package.json` script and README note (plus historical plans). Prefer delete over deprecation shim; no external package consumers.

## Implementation units

### U1. Surface failure detail on receipts and console

- **Goal:** Failed runs persist and display why they failed.
- **Requirements:** R1
- **td:** td-b4d2ee
- **Files:** `src/pipeline/receipt.ts`, `src/pipeline/review-receipt.ts`, `src/pipeline/run.ts`, `src/pipeline/review-run.ts`, `ui/shared/operator-run.ts`, `ui/app/components/operator/OperatorConsole.tsx`, `test/pipeline/run.test.ts`, `test/pipeline/review-run.test.ts`, `test/pipeline/receipt.test.ts` (if serialization helper covered), `ui/server/operator-runs.spec.ts` as needed
- **Approach:** Add optional `errorMessage?: string` to `RunReceipt` and `ReviewRunReceipt` and the UI `OperatorRunReceipt` mirror. In both catch paths, set `errorMessage` from the thrown error message after the same redaction used for logs/registry. Ensure progress emission includes it before write. In `RunProgress` / failure banner, show `record.receipt?.errorMessage ?? record.message`. Preserve `errorCode`.
- **Tests:** Failed verify/policy fixtures assert receipt JSON includes non-empty `errorMessage` and existing `errorCode`; UI/shared shape test or registry test asserts failed record exposes the message; success path leaves `errorMessage` absent.
- **Verification:** `bun test test/pipeline/run.test.ts test/pipeline/review-run.test.ts test/pipeline/receipt.test.ts` and `cd ui && pnpm exec vitest run server/operator-runs.spec.ts shared/operator-run.spec.ts`

### U2. Expand secret redaction for model API keys

- **Goal:** Model key shapes never land in durable receipts.
- **Requirements:** R2
- **td:** td-b90e24
- **Files:** `src/pipeline/receipt.ts`, `test/pipeline/receipt.test.ts`
- **Approach:** Extend `TOKEN_PATTERNS` with high-confidence model key / bearer forms, for example:
  - OpenAI-style `sk-` tokens with sufficient length
  - Anthropic `sk-ant-`
  - OpenRouter `sk-or-`
  - `Bearer` + long token
  Export a shared predicate for U3 (e.g. `containsSecretLikeContent`). Keep review path on `redactSecrets` only — no second pattern list. Add negative cases: ordinary titles, short `sk-` fragments if avoided by length bounds, commit SHAs, provider/model JSON.
- **Tests:** Table-driven samples for each positive shape become `[REDACTED]`; prose/SHA/provider fixtures unchanged.
- **Verification:** `bun test test/pipeline/receipt.test.ts`

### U3. Block secret-looking content in publishable patches

- **Goal:** Policy refuses to publish secrets embedded in diffs.
- **Requirements:** R3
- **td:** td-c81000
- **Depends on:** U2
- **Files:** `src/pipeline/policy.ts`, `src/pipeline/run.ts` (only if summary typing needs adjustment), `src/pipeline/review-run.ts` (same), `test/pipeline/policy.test.ts`, `test/pipeline/run.test.ts` / `review-run.test.ts` if end-to-end policy path not already covered
- **Approach:** Teach `assertPublishableChange` to inspect `patch` text via the shared detector from U2. Both pipelines already call `assertPublishableChange(changes)` after `inspectChanges()`. Keep path/size/empty rules. Error text must be explicit (`publication blocked: patch appears to contain a secret` or similar) without echoing the secret.
- **Tests:** Synthetic patch with PEM and with `ghs_` / `sk-` fails; clean `src/index.ts` patch still passes; protected-path and size tests remain green.
- **Verification:** `bun test test/pipeline/policy.test.ts test/pipeline/run.test.ts test/pipeline/review-run.test.ts`

### U4. Cancel in-flight operator runs via AbortSignal

- **Goal:** Operator can stop a hung run cleanly.
- **Requirements:** R4
- **td:** td-02ef5d
- **Files:** `ui/server/operator-runs.ts`, `ui/server/operator-runs.spec.ts`, `ui/shared/operator-run.ts` (only if action schema helpers needed), new `ui/actions/cancel-shipwright-run.ts` (name may match Agent Native action file conventions), `ui/app/components/operator/OperatorConsole.tsx`, `src/cli/dependencies.ts` only if signal must be threaded where demo/real executors are built
- **Approach:** Registry holds `Map<runId, AbortController>` (or controller on the active run). `start` creates controller and passes `signal` into `executePipeline` / `createPipelineDependencies({ signal })` and demo executor (demo should honor abort between phases). Add `cancel(runId)` that aborts, is no-op/errors clearly if missing or already terminal. Wire action + console Cancel button while `active`. On abort, existing `abortable` / `throwIfAborted` ends the pipeline; catch path writes receipt; registry marks failed with cancellation message. Clearing the controller entry in `finally` of `#run` is required so the next start is allowed.
- **Tests:** Start mock long-running execute, cancel, assert terminal failed + no second-active block after; cancel unknown/terminal run behaves safely; signal reaches executor.
- **Verification:** `cd ui && pnpm exec vitest run server/operator-runs.spec.ts`

### U5. Align timeout defaults and show provider/model

- **Goal:** Console defaults and identity match operator expectations.
- **Requirements:** R5
- **td:** td-8db3ce
- **Files:** `ui/shared/operator-run.ts`, `ui/app/components/operator/OperatorConsole.tsx`, `ui/shared/operator-run.spec.ts`, `ui/server/operator-runs.spec.ts` (fixture timeout 20 → 30 where asserting defaults)
- **Approach:** Change schema `.default(20)` and component `useState(20)` to `30`. Surface `record.receipt.execution.provider` / `.model` in the evidence header or evidence strip when receipt exists. No receipt schema change required (`execution` already present).
- **Tests:** Schema default parse without timeout yields 30; optional component/shared assertion that execution fields remain on the record type.
- **Verification:** `cd ui && pnpm exec vitest run shared/operator-run.spec.ts server/operator-runs.spec.ts`

### U6. Capture verification stdout/stderr tails

- **Goal:** Failed verify leaves actionable evidence on the receipt and console.
- **Requirements:** R6
- **td:** td-cdbc57
- **Depends on:** U1
- **Files:** `src/pipeline/run.ts` (`WorkspacePort`), `src/pipeline/review-run.ts` if it shares the port typing, `src/pipeline/receipt.ts`, `src/pipeline/review-receipt.ts` if verification shape duplicated, `src/sandbox/runtime.ts`, test fakes in `test/pipeline/run.test.ts` / `review-run.test.ts`, `test/sandbox/runtime.test.ts` if present, `ui/shared/operator-run.ts`, `ui/app/components/operator/OperatorConsole.tsx`
- **Approach:** Have `verify` return tails (truncate helper: last 8 KiB per stream). Populate `receipt.verification.stdoutTail` / `stderrTail` before pass/fail decision; always redact via `writeReceipt`. Console Evidence shows tails when `passed === false` (disclosure acceptable). Demo executor may omit tails.
- **Tests:** Fake verify returning stderr asserts receipt tails; truncation test for oversized output; redaction test if tail contains a token pattern.
- **Verification:** `bun test test/pipeline/run.test.ts test/sandbox/runtime.test.ts` and UI typecheck/tests touching operator-run types

### U7. Durable run history browser

- **Goal:** Refresh does not lose prior run evidence.
- **Requirements:** R7
- **td:** td-894653
- **Depends on:** U1
- **Files:** `ui/server/operator-runs.ts`, `ui/server/operator-runs.spec.ts`, `ui/shared/operator-run.ts`, new `ui/actions/list-shipwright-runs.ts`, `ui/app/components/operator/OperatorConsole.tsx`
- **Approach:** Add registry `list(limit = 50)` sorted by `startedAt` or insertion/updated newest-first. List action returns summary fields needed for the rail (`runId`, `status`, `phase`, `startedAt`, issue URL, optional PR URL/error snippet) — full record still via `get`. Console: history rail, click sets `runId`, polling rules unchanged for active selection. Empty demo/memory stores still work.
- **Tests:** Persist multiple runs, new registry process lists newest-first and bounds length; get-by-id still returns full receipt including `errorMessage` from U1.
- **Verification:** `cd ui && pnpm exec vitest run server/operator-runs.spec.ts`

### U8. Review-agent in the operator console

- **Goal:** Operators can run the existing review pipeline from the console.
- **Requirements:** R8
- **td:** td-ca269b
- **Depends on:** U4, U7
- **Files:** `ui/shared/operator-run.ts` (request schema union/mode), `ui/server/operator-runs.ts`, `ui/actions/start-shipwright-run.ts` (or dedicated start-review action if cleaner), `ui/app/components/operator/OperatorConsole.tsx`, `src/cli/dependencies.ts` (`createReviewPipelineDependencies`), tests under `ui/server` / `ui/shared`, light docs touch in `README.md` operator section if needed
- **Approach:** Add console mode toggle: Issue → PR vs Review PR. Review fields: PR URL, skill path, verify command, timeout, publish + confirm. Validate canonical PR URL pattern (mirror CLI/review-args rules). Execute via `runReviewAgent` + review deps with the same AbortSignal and progress → record mapping. Map review receipt into the operator record view (phase set may include `threads`; extend `RUN_PHASES` or keep a parallel phase list for review mode). History list shows both kinds if stored in the same registry — tag `kind: "issue" | "review"` on the record to render the right evidence. Never send skill file contents to the client; receipt already stores skill digest only.
- **Tests:** Request validation rejects issue URL in review mode and missing skill path; dry-run demo or fake executor succeeds; publish requires confirmation flag; cancel still works (U4).
- **Verification:** `cd ui && pnpm exec vitest run server/operator-runs.spec.ts shared/operator-run.spec.ts` plus `bun run typecheck` and `cd ui && pnpm typecheck`

### U9. Document Tailscale-only host access

- **Goal:** Ops docs match the empty public SSH firewall reality.
- **Requirements:** R9
- **td:** td-2aa807
- **Files:** `docs/deployment.md`, `README.md` only if the deploy pointer is misleading
- **Approach:** In Provision/Private access/Verify, state that public SSH may time out by design when the cloud firewall has no SSH rule; primary access is Tailscale SSH (`tailscale ssh` / Tailscale IP) and `tailscale serve` for the console. Optional break-glass: temporarily allow source-IP-restricted SSH. No secrets.
- **Tests:** None (docs only). Proof: read back the sections for Tailscale-first language.
- **Verification:** `rg -n 'Tailscale|SSH|firewall' docs/deployment.md README.md`

### U10. Retire programming-agent alias

- **Goal:** Remove rename debt from scripts and operator-facing docs.
- **Requirements:** R10
- **td:** td-a28c36
- **Files:** `package.json`, `README.md`
- **Approach:** Delete the `programming-agent` script entry and the README temporary-alias sentence. Leave historical `docs/plans/*` alone. Confirm with repo search excluding plans/node_modules.
- **Tests:** None beyond search. Optional: ensure `bun run shipwright` script still present.
- **Verification:** `rg -n 'programming-agent' --glob '!docs/plans/**' --glob '!node_modules/**' --glob '!.git/**'` returns no operator-facing hits; `bun run shipwright -- --help` or args test still works via existing CLI tests.

## Worktree & concurrency

- **worktree_slug:** `feat/operator-evidence-safety-console`
- **spine_owner:** self (single epic owner). Shared spine files force serialization across many units: `src/pipeline/receipt.ts`, `src/pipeline/run.ts`, `ui/server/operator-runs.ts`, `ui/shared/operator-run.ts`, `ui/app/components/operator/OperatorConsole.tsx`.
- **Pre-flight:** from repo root, if available: `~/.hub/scripts/worktree-posture.sh --claim feat/operator-evidence-safety-console --surfaces "src/pipeline/receipt.ts,src/pipeline/run.ts,src/pipeline/policy.ts,ui/server/operator-runs.ts,ui/shared/operator-run.ts,ui/app/components/operator/OperatorConsole.tsx"`
- **Active conflicts:** none observed on 2026-07-20; primary checkout `main` clean at plan authoring.

### Write surfaces

- U1: `src/pipeline/receipt.ts`, `src/pipeline/review-receipt.ts`, `src/pipeline/run.ts`, `src/pipeline/review-run.ts`, `ui/shared/operator-run.ts`, `ui/app/components/operator/OperatorConsole.tsx`, pipeline/UI tests
- U2: `src/pipeline/receipt.ts`, `test/pipeline/receipt.test.ts`
- U3: `src/pipeline/policy.ts`, `test/pipeline/policy.test.ts` (+ pipeline tests if needed)
- U4: `ui/server/operator-runs.ts`, `ui/actions/cancel-shipwright-run.ts`, `ui/app/components/operator/OperatorConsole.tsx`, `src/cli/dependencies.ts` (signal thread if required), UI tests
- U5: `ui/shared/operator-run.ts`, `ui/app/components/operator/OperatorConsole.tsx`, UI tests
- U6: `src/pipeline/run.ts`, `src/sandbox/runtime.ts`, receipt types, OperatorConsole, tests
- U7: `ui/server/operator-runs.ts`, `ui/actions/list-shipwright-runs.ts`, OperatorConsole, tests
- U8: operator-run schema, operator-runs registry/executor, OperatorConsole, actions, tests, light README
- U9: `docs/deployment.md`, maybe `README.md`
- U10: `package.json`, `README.md`

### Suggested execution waves

1. **Wave A (P1 foundation, serialize receipt spine):** U1 → U2 → U3; U4 can start after U1 if separate careful ownership of `operator-runs.ts` / console, else after U1.
2. **Wave B (P2 evidence):** U5 anytime after Wave A starts (low conflict if console edits coordinated); U6 after U1; U7 after U1.
3. **Wave C (P2 review UI):** U8 after U4 and U7.
4. **Wave D (P3 chores):** U9 and U10 anytime in parallel with anything; lowest risk last or first as quick wins.

Critical path for unblocking the largest feature: **U1 → U7 and U4 → U8**, with **U2 → U3** as the parallel safety path.

## Prior learnings applied

- No `docs/solutions/` corpus exists in this repo yet; none cited.
- Prior plans (`docs/plans/2026-07-18-feat-programming-agent-example-plan.md`, `docs/plans/2026-07-19-feat-agentos-pr-review-feedback-plan.md`) established: atomic mode-0600 receipts, host-side GitHub credentials, `redactSecrets` on write, single active operator run, demo mode via `SHIPWRIGHT_UI_DEMO=1`, review receipts under `review-receipts` with skill digest only. This plan extends those seams rather than replacing them.

## Deferred / out of scope

- Multi-active concurrent runs
- Raising console `timeoutMinutes` max from 60 to 120
- Autonomous merge, public multi-tenant SaaS, exposing model keys to the sandbox
- Reworking Agent Native auth or Tailscale serve automation
- Rewriting historical plan docs that still say `programming-agent`
- Full E2E live publish as part of each unit (opt-in `bun run test:live` remains separate)
- Changing cloud firewall automatically from this repo

## Open questions

None blocking. Defaults above are locked for execution:

- Cancel → `failed` + cancellation message/code (no new status).
- Secret detection shared from receipt module.
- Verify tails 8 KiB each, last-window.
- History limit 50.
- Console timeout default 30 / max 60.
- Alias hard-removed.

## Validation and Acceptance (epic-level)

After all units:

```sh
bun test
bun run typecheck
cd ui && pnpm test && pnpm typecheck && pnpm build
```

Optional smoke:

```sh
SHIPWRIGHT_UI_DEMO=1 bun run dev
```

Operator checks in demo or real mode: failed run shows message; cancel stops active run; history survives refresh; review dry-run path visible; docs mention Tailscale-first SSH; `programming-agent` script gone.

## td mapping

| Unit | Issue | Priority | Depends |
| --- | --- | --- | --- |
| U1 | td-b4d2ee | P1 | — |
| U2 | td-b90e24 | P1 | — |
| U3 | td-c81000 | P1 | U2 / td-b90e24 |
| U4 | td-02ef5d | P1 | — |
| U5 | td-8db3ce | P2 | — |
| U6 | td-cdbc57 | P2 | U1 / td-b4d2ee |
| U7 | td-894653 | P2 | U1 / td-b4d2ee |
| U8 | td-ca269b | P2 | U4, U7 |
| U9 | td-2aa807 | P3 | — |
| U10 | td-a28c36 | P3 | — |

## Revision History

- 2026-07-20: Initial plan from td-f87a9b children and current main checkout (`receipt.ts` errorCode-only, TOKEN_PATTERNS without model keys, policy path/size only, registry without cancel/list, console timeout 20 / no history / issue-only).
