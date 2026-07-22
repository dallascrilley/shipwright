---
date: 2026-07-22
origin: docs/brainstorms/2026-07-22-github-trigger-condition-filtering-requirements.md
td_epic: td-18bac8
---

# GitHub trigger condition filtering plan

Living document. Update Progress, Surprises & Discoveries, Decision Log, Outcomes & Retrospective, and Revision History whenever implementation stops or a decision changes.

**Summary:** Add optional, typed, trigger-scoped conditions for GitHub automations. Operators can filter by event actor, labels, pull-request base branch, or pull-request draft state using readable event-aware controls. Signed webhook delivery remains fail-closed, replay-safe, owner-scoped, and bounded; existing triggers remain unconditional.

## Purpose / Big Picture

After this work, an operator can narrow an **Issue created**, **Issue edited**, **Pull request created**, or **Commits pushed to pull request** trigger without writing a raw expression. A trigger may require an actor membership rule, label rule, and—on pull requests only—a base branch or draft-state rule. Conditions within one trigger use AND. Multiple triggers remain alternatives, so any matching trigger can cause one execution for the agent revision and delivery.

Existing trigger records with no conditions continue to match exactly as they do now. Missing or malformed event data required by a configured condition causes that trigger not to match. The webhook route returns bounded reason-code-only decision evidence and never retains raw payloads or delivered actor, label, branch, or draft values.

## Progress

- [x] (2026-07-22 23:30Z) Grounded the plan in the approved R1-R13 requirements, current shared schemas, management service, operator console, signed webhook route, queue idempotency, and tests.
- [x] (2026-07-22 23:34Z) Resolved compatibility, export versioning, evaluator placement, multi-trigger convergence, evidence, and normalization as planning decisions.
- [x] (2026-07-22 23:38Z) Imported epic `td-18bac8` with U1 `td-049b5b`, U2 `td-adf814`, U3 `td-97bc77`, and U4 `td-f806ac`; verified the import receipt.
- [x] (2026-07-22 23:45Z) U1: Added strict typed condition schemas, event-aware validation, bounded normalization, readable summaries, version-1 export compatibility, and current version-2 output; 133 UI tests and typecheck pass.
- [x] (2026-07-22 23:52Z) U2: Added pure fail-closed condition evaluation, verified-payload field extraction, deterministic alternative grouping, one dispatch per agent revision and delivery, and capped reason-code-only ingress decisions; 20 focused tests and typecheck pass.
- [x] (2026-07-22 23:59Z) U3: Added a bounded event-aware condition editor with repeatable exact-value inputs, visible removal of inapplicable rows, atomic create/replace state, readable saved summaries, and version-2 copy proof; desktop and 390 px browser checks pass.
- [ ] U4: Prove the public route, UI, safety, regressions, and documentation.

## Surprises & Discoveries

- Observation: The stored control-plane snapshot is already explicitly version 1, and existing GitHub trigger configuration is a strict event/actions object. Compatibility therefore requires an optional/default-empty `conditions` field rather than a snapshot version migration.
- Observation: Copy-as-JSON is a separate projection from the durable control-plane snapshot. Its current version 1 can advance independently to version 2 without changing persisted state or adding JSON import.
- Observation: The dispatcher idempotency key already converges on GitHub delivery plus agent revision. The webhook loop still evaluates and attempts dispatch per trigger, so this slice should group alternatives before dispatch to make the one-execution rule explicit and to report accurate match counts.
- Observation: `ui/server/github-webhook.ts` currently extracts only action, repository, and target data. Actor, labels, base branch, and draft state must be extracted only after signature verification and JSON parsing, then represented by a small internal context rather than exposing the raw payload to the evaluator.
- Observation: There is no durable webhook-evaluation store. Reusing lifecycle history for every filtered delivery would create noisy, unbounded agent state. A capped ingress decision receipt is the narrowest existing evidence surface.
- Observation: The public H3 route has dedicated signed-request tests. Prior solution guidance correctly warns that library-only webhook tests do not prove the actual mounted HTTP contract.
- Observation: The operator console has no direct component test suite. Pure shared projection tests plus desktop and 390 px browser proof are the proportionate way to cover readable condition controls without introducing a new UI test framework.
- Observation: A realistic conditioned pull-request payload can omit the top-level condition fields while still providing the dispatch target. Keeping target validation separate from condition field states preserves unconditional compatibility and lets configured conditions fail closed with precise missing or malformed reason codes.
- Observation: A comma-separated membership input would corrupt legitimate GitHub label names containing commas. Repeatable one-value inputs preserve exact values and make the 25-value/100-character bounds visible without an escaping mini-language.

## Requirements

- **R1. Optional trigger-scoped conditions.** Existing triggers without conditions retain unconditional behavior.
- **R2. Typed first-slice fields.** Support event actor and labels for issue and pull-request triggers; support base branch and draft state only for pull-request triggers.
- **R3. Field-specific operators.** Actor and base branch support **is one of** / **is not one of**; labels support **include any** / **include all** / **include none**; draft supports **is draft** / **is not draft**.
- **R4. Stable comparison semantics.** Actor and label comparisons are case-insensitive, base branch comparison is exact, and configured conditions within one trigger use AND.
- **R5. Alternative trigger semantics.** Multiple triggers act as OR alternatives, but one agent revision receives at most one execution for a delivery even when multiple alternatives match.
- **R6. Fail-closed event data.** Missing or malformed data required by a condition makes that trigger a non-match.
- **R7. Readable editing.** Conditions are configured through event-aware controls, not raw expressions.
- **R8. Versioned JSON representation.** Copy-as-JSON distinguishes the conditioned contract from version 1 and preserves conditions deterministically.
- **R9. Evaluation placement.** Evaluate after body limit, HMAC, event parsing, repository scope, and enabled checks; evaluate before queueing. Existing start-time repository authorization remains in force.
- **R10. Bounded redacted evidence.** Operators receive safe reason-code evidence without raw payloads or delivered condition values being stored.
- **R11. Safety monotonicity.** Conditions can only narrow execution and cannot bypass signature, repository, activation, idempotency, or publication controls.
- **R12. Bounded definitions.** At most 10 condition rows, 25 values per membership condition, and 100 characters per value.
- **R13. Signed HTTP proof.** Tests cover match, nonmatch, missing condition data, multiple matching alternatives, and replay through the public route.

## Decision Log

- Decision: Keep the durable control-plane snapshot at version 1 and add `conditions` as an optional field. Preserve absence when parsing legacy records, treat absence as an empty array in all consumers, and emit an explicit array in version-2 exports. Rationale: absence already has the correct unconditional meaning, so no snapshot migration or rewrite is needed, and old persisted objects retain their original shape. Date/Author: 2026-07-22 / Codex.
- Decision: Model conditions as a strict discriminated union keyed by `field`, with only the operators and value shapes allowed for that field. Add event-aware refinement at the curated GitHub trigger boundary. Rationale: invalid combinations fail before persistence and downstream code remains exhaustive. Date/Author: 2026-07-22 / Codex.
- Decision: Preserve both `agentDefinitionExportV1Schema` and `agentDefinitionExportV2Schema`, expose a union for compatibility, and make the current exporter emit version 2 with normalized conditions. Rationale: Copy-as-JSON is versioned public output even though import is out of scope. Date/Author: 2026-07-22 / Codex.
- Decision: Trim configured membership values and remove exact duplicates while preserving first-entered casing and order. Perform actor/label case folding only during evaluation; compare base branches exactly. Rationale: deterministic exports stay readable without changing specified comparison behavior. Date/Author: 2026-07-22 / Codex.
- Decision: Put condition evaluation in a pure `ui/server/github-trigger-conditions.ts` module that accepts a narrow verified-event context and returns matched state plus reason codes. Rationale: this isolates comparison semantics, keeps raw webhook data out of evidence, and supports focused tests. Date/Author: 2026-07-22 / Codex.
- Decision: After event/action/repository/scope checks, group eligible triggers by agent revision, evaluate every alternative, and dispatch once using the lexicographically first matching trigger ID. Rationale: this makes OR semantics deterministic and guarantees one execution independent of dispatcher deduplication. Date/Author: 2026-07-22 / Codex.
- Decision: Return a capped ingress decision receipt containing aggregate counts and at most 20 `{triggerId, decision, reasonCodes}` items plus a truncation count. Do not append lifecycle events or add process-local metrics in this slice. Rationale: the response is observable in GitHub delivery history while avoiding durable payload-derived state and unclear metric restart semantics. Date/Author: 2026-07-22 / Codex.
- Decision: Reuse the existing create/replace trigger actions; do not add a separate condition mutation endpoint. Rationale: trigger configuration stays atomic under the existing optimistic revision contract. Date/Author: 2026-07-22 / Codex.
- Decision: Keep the first slice sequential. Rationale: U1 defines shared schemas used by both webhook and UI work; parallel writers would contend on the same shared files for little speed gain. Date/Author: 2026-07-22 / Codex.

## Context and Orientation

`ui/shared/agent-definition.ts` owns the persistent snapshot and trigger schemas. `githubTriggerConfigSchema` currently accepts only `event` and bounded `actions`; `curatedGithubTriggerConfigSchema` narrows new definitions to the four supported choices. Add condition definitions, bounds, normalization, and event-aware refinement here while leaving schedule triggers untouched.

`ui/shared/agent-management.ts` owns operator-facing trigger projections and Copy-as-JSON. Split the current export schema into explicit version-1 and version-2 forms, make current export generation deterministic, and render condition summaries from shared typed helpers rather than duplicating field/operator labels in React.

`ui/server/github-webhook.ts` verifies the signature, parses the payload, enforces repository scope and enabled state, resolves revisions, and dispatches. It is the only integration point for condition evaluation. The new evaluator module must receive only extracted event data, never the raw body. `ui/server/routes/api/github/webhook.post.ts` remains the mounted public boundary and its spec supplies the end-to-end signed HTTP proof.

`ui/server/agent-control-plane.ts` already validates trigger creation/replacement through the shared schema and makes changes transactionally. No new state service or action is required.

`ui/app/components/operator/AgentManagementConsole.tsx` owns trigger form state and invokes the existing create/replace actions. Extend that form with condition rows whose available fields and operators derive from the selected event. Existing legacy GitHub triggers remain read-only/removable; unconditional curated triggers remain editable.

## Key technical decisions

- Define four condition variants: actor membership, label membership, base-branch membership, and draft predicate. Each variant has only its valid operators and payload shape.
- Export shared limits for maximum rows, values, and value length so schemas and the editor cannot drift.
- Normalize configuration at the schema/service boundary. Empty membership values are invalid; draft conditions carry no arbitrary value.
- Event-aware validation allows actor and labels on both GitHub events and rejects base branch or draft on `issues`.
- Treat a configured condition whose required event field is absent, wrong-typed, or structurally malformed as a non-match with a safe missing/malformed reason code.
- Extract `sender.login` for actor; issue or pull-request label names for labels; `pull_request.base.ref` for base branch; and `pull_request.draft` for draft state.
- Evaluate trigger rows with AND and trigger alternatives with OR. A nonmatching alternative never suppresses a matching alternative for the same revision.
- Dispatch once per agent revision and delivery. Keep the existing idempotency key as the replay backstop.
- Cap decision evidence independently of input size. Reason codes describe configured checks (`actor_mismatch`, `labels_missing`, `base_branch_mismatch`, `draft_mismatch`, `condition_data_missing`, `condition_data_malformed`) and never echo observed values.
- Keep authorization, activation, target parsing, queue bounds, and publication policy code unchanged except for placing the narrowing evaluator before dispatch.
- Add no dependency and no general-purpose expression language.

## Implementation units

### U1. Typed condition contracts and versioned export — `td-049b5b`

- **Goal:** Establish strict reusable condition types, compatibility rules, readable projections, and deterministic version-2 export before runtime or UI behavior changes.
- **Requirements:** R1, R2, R3, R6, R8, R12.
- **Files:** `ui/shared/agent-definition.ts`; `ui/shared/agent-definition.spec.ts`; `ui/shared/agent-management.ts`; `ui/shared/agent-management.spec.ts`.
- **Approach:** Add shared limits and the discriminated condition schemas. Extend the broad GitHub trigger config with optional/default-empty conditions and refine curated definitions by event. Add normalization helpers. Preserve a named version-1 export schema, add version 2 with conditions, expose a v1/v2 union, and make current projection emit v2. Add shared readable field/operator/value summaries for the UI.
- **Tests:** Existing snapshot without conditions; unconditional parsed result; every valid field/operator combination; event-inapplicable fields; row/value/length limits; empty and duplicate values; deterministic normalization; version-1 parse; version-2 round trip; condition ordering and readable summaries; no secret/audit/queue/raw payload fields.
- **Verification:** `cd ui && pnpm exec vitest run shared/agent-definition.spec.ts shared/agent-management.spec.ts`; `cd ui && pnpm typecheck`.

### U2. Signed webhook evaluation and bounded receipt — `td-adf814`

- **Goal:** Evaluate typed conditions against verified payload data before queueing and guarantee one execution per revision and delivery.
- **Requirements:** R4, R5, R6, R9, R10, R11.
- **Files:** create `ui/server/github-trigger-conditions.ts`; create `ui/server/github-trigger-conditions.spec.ts`; modify `ui/server/github-webhook.ts`; modify `ui/server/github-webhook.spec.ts`; modify `ui/server/routes/api/github/webhook.post.spec.ts`; modify shared result types only where the route contract requires them.
- **Approach:** Parse a narrow condition context after HMAC and JSON validation. Implement exhaustive pure evaluation with safe reason codes. Refactor eligible trigger processing into agent-revision groups, evaluate alternatives, choose the first matching trigger ID in stable order, and invoke the dispatcher once. Extend accepted route output with aggregate matched/filtered counts and capped decisions while preserving existing rejection responses.
- **Tests:** Actor equality/inequality with case folding; label any/all/none with case folding; exact base branch equality/inequality; draft predicates; AND rows; missing and malformed data; one failing and one matching alternative; two matching alternatives dispatch once; two revisions dispatch separately; replay stays deduplicated; response cap/truncation; raw body and observed values absent from snapshot, queue, and response.
- **Verification:** `cd ui && pnpm exec vitest run server/github-trigger-conditions.spec.ts server/github-webhook.spec.ts server/routes/api/github/webhook.post.spec.ts`; `cd ui && pnpm typecheck`.

### U3. Readable event-aware condition editor — `td-97bc77`

- **Goal:** Let operators configure and understand supported conditions through the existing GitHub trigger create/replace workflow.
- **Requirements:** R2, R3, R4, R7, R8, R11, R12.
- **Files:** `ui/app/components/operator/AgentManagementConsole.tsx`; `ui/shared/agent-definition.ts`; `ui/shared/agent-management.ts`; matching shared specs; `ui/README.md` only if it documents the console workflow.
- **Approach:** Add typed condition draft state under the GitHub trigger form. Populate field and operator options from shared event-aware catalogs, use token/list entry for membership conditions and a predicate selector for draft, show row/value limits, and allow add/remove. Reset or reject inapplicable rows when the event changes. Send normalized conditions through existing create/replace mutations and render concise summaries on saved trigger rows. Keep unconditional and legacy behavior intact.
- **Tests:** Pure catalog/projection tests cover event-applicable controls and summaries; action/service tests prove create and replace receive/persist normalized conditions and reject invalid drafts; browser proof covers add/edit/remove, event switch, validation, version-2 copy, existing unconditional trigger, desktop, and 390 px width.
- **Verification:** `cd ui && pnpm exec vitest run shared/agent-definition.spec.ts shared/agent-management.spec.ts server/agent-management.spec.ts`; `cd ui && pnpm typecheck && pnpm build`; run the local UI and capture desktop and 390 px condition-editor states through the in-app browser.

### U4. Public-route proof, regression gate, and documentation — `td-f806ac`

- **Goal:** Prove the complete conditioned-trigger contract through the actual HTTP route and document its safe operating semantics.
- **Requirements:** R5, R9, R10, R11, R13.
- **Files:** `ui/server/routes/api/github/webhook.post.spec.ts`; `README.md`; `ui/README.md`; `docs/solutions/` for the completed non-obvious condition-filtering pattern; any narrow fixture updates required by the full gate.
- **Approach:** Add signed HTTP scenarios for every required outcome, inspect durable queue state and response evidence, and verify replay at the route boundary. Update operator/developer documentation with field/operator semantics, AND/OR behavior, bounds, version-2 export, fail-closed behavior, and deferred expression features. Use the `ce-compound` skill after the fix to capture the reusable signed-webhook/evidence pattern, as explicitly requested by the user.
- **Tests:** Signed match; signed nonmatch; required field absent; malformed required field; two matching alternatives with one queued execution; same delivery replay; decision receipt cap and redaction; existing unconditional signed delivery; invalid signature and body limits unchanged.
- **Verification:** focused signed route tests; `cd ui && pnpm test && pnpm typecheck && pnpm build`; repository-level `bun run verify`; browser proof; final diff review; clean status.

## Worktree & concurrency

- **worktree_slug:** `feat/github-trigger-condition-filtering`
- **spine_owner:** self
- **Pre-flight:** inspect `git worktree list --porcelain`, current branch/status, and `.agents-state` ownership if present before implementation. The plan worktree is documentation-only; create a fresh implementation worktree from reviewed current `origin/main` after plan integration.
- **Active conflicts:** none observed at planning time. The primary checkout is intentionally divergent and read-mostly; all implementation belongs in the isolated worktree. Re-run pre-flight before edits.

### Write surfaces

- **U1:** `ui/shared/agent-definition*`, `ui/shared/agent-management*`.
- **U2:** `ui/server/github-trigger-conditions*`, `ui/server/github-webhook*`, `ui/server/routes/api/github/webhook.post.spec.ts`.
- **U3:** `ui/app/components/operator/AgentManagementConsole.tsx`, shared condition catalogs/projections and their tests, optional `ui/README.md` section.
- **U4:** public route specs, `README.md`, `ui/README.md`, `docs/solutions/`, and only fixtures exposed by the full gate.

U2 and U3 both depend on U1. They could proceed concurrently only after U1 is committed, but U3 also consumes shared projection files and U4 integrates both. A single sequential executor is the lowest-risk default. If another active owner appears, do not race shared files; serialize U1/U3 and route-only U2 changes or create nonoverlapping worktrees with explicit ownership.

## Plan of Work

Implement U1 test-first so all later code consumes one typed contract. Use legacy fixtures before changing the schema to prove absence of conditions remains unconditional. Commit only after shared tests and UI typecheck pass.

Implement U2 around a pure evaluator, then integrate it into the verified webhook path. First prove comparison and fail-closed semantics in isolation. Next add grouping and one-dispatch behavior. Finish with signed route tests and receipt redaction. Do not change start-time authorization or publication logic.

Implement U3 using shared catalogs and projections rather than component-local strings. Exercise create and atomic replace through existing action/service boundaries. Validate responsive and error states in a live browser.

Complete U4 with public-route scenarios, full verification, documentation, and a `docs/solutions/` capture. Review the complete diff at the exact tested head, push through the normal PR path, refresh checks/reviews, and merge only when all required evidence is green.

## Milestones

### Milestone 1: Compatible typed contract

U1 is complete when existing snapshots parse as unconditional, invalid field/operator/event combinations fail, limits are enforced, and version-2 Copy-as-JSON round-trips conditions deterministically while version 1 remains parseable.

### Milestone 2: Safe runtime narrowing

U2 is complete when verified payloads satisfy the exact comparison semantics, missing/malformed required data fails closed, alternatives converge to one dispatch, replay remains deduplicated, and receipt evidence contains only bounded reason codes.

### Milestone 3: Operator workflow

U3 is complete when the operator can add, edit, remove, inspect, and export conditions with only event-applicable controls at desktop and 390 px, while existing unconditional and legacy triggers remain usable.

### Milestone 4: End-to-end proof and capture

U4 is complete when signed public-route tests cover R13, the full local gate passes, the UI has browser proof, documentation matches verified behavior, the reusable solution is captured, and no agent-owned dirt remains.

## Concrete Steps

Create the implementation worktree from the reviewed plan head. Start `td-049b5b`, run its focused baseline, write failing contract tests, implement U1, update this plan, and commit with the td ID. Repeat for `td-adf814`, then `td-97bc77`, respecting dependency order. Start `td-f806ac` only after both runtime and editor units are reviewable.

At each unit boundary, read the focused test output and `git diff --check`, inspect the staged diff by path, commit only owned files, and update td with decisions or blockers. After U4, invoke `verify-before-complete`, run the full repository gate once, review the tested head, and follow the repository's commit/push/PR/CI closeout workflow.

## Validation and Acceptance

The implementation is accepted only when every R1-R13 mapping above is covered and these observable behaviors hold:

1. A saved trigger with no conditions behaves exactly like the current unconditional trigger.
2. Issue triggers offer actor and label conditions only; pull-request triggers additionally offer base branch and draft state.
3. Configured rows use AND; multiple trigger records use OR.
4. Actor and label comparisons ignore case, while base branch comparison is exact.
5. Missing or malformed required event data produces no queue entry and a safe reason code.
6. Multiple matching trigger alternatives for one agent revision and delivery produce one queue execution.
7. A replayed delivery remains deduplicated.
8. Version-2 Copy-as-JSON includes normalized conditions; version-1 documents remain parseable; no import capability is implied.
9. Evidence never returns or persists raw payloads or observed actor, label, branch, or draft values.
10. Existing signature, owner scope, enabled-state, body-limit, queue, authorization, and publication protections still pass.
11. The editor is usable at desktop and 390 px and clearly communicates limits and validation.
12. The public signed HTTP route proves match, nonmatch, missing/malformed data, overlapping alternatives, and replay.

The final local gate is:

```sh
bun run verify
```

Read its terminal exit status and retain the focused U1-U4 outputs. Browser proof is required in addition to the command gate because the change modifies a user-visible form.

## Idempotence and Recovery

Condition evaluation is pure and side-effect-free. A non-match never mutates the queue or agent state. The existing delivery/revision idempotency key remains the final replay guard; explicit pre-dispatch grouping prevents redundant attempts before that guard.

Schema changes are additive. Older snapshots omit conditions and remain unconditional. No durable migration rewrites existing files. If version-2 export or UI rendering fails, stored agents and triggers remain readable through the broad persisted schema.

Trigger create/replace stays atomic and optimistic. A stale revision refreshes instead of overwriting newer state. If the editor event changes, discard only inapplicable unsaved condition rows after a visible confirmation or block save until the operator resolves them; never silently rewrite persisted rows.

The receipt cap prevents delivery size from expanding response evidence without bound. Re-running signed tests must use fresh delivery IDs except for the explicit replay case. No test may use `publish_allowed`.

Rollback is application-only: return to the previous revision. Because stored version-1 snapshots remain readable and no migration occurs, rollback does not require data repair. Triggers saved with conditions must not be activated by an older application that ignores unknown fields; the strict older schema will reject those snapshots, so deploy and rollback validation must use a copied conditioned snapshot before production rollout.

## Interfaces and Dependencies

- `ui/shared/agent-definition.ts`: condition schemas, limits, normalization, event-aware validation, and backward-compatible persistent trigger contract.
- `ui/shared/agent-management.ts`: v1/v2 export schemas, current v2 builder, readable condition projections, and legacy classification.
- `ui/server/github-trigger-conditions.ts`: narrow verified-event context, exhaustive evaluator, safe decision/reason-code types.
- `ui/server/github-webhook.ts`: verified context extraction, alternative grouping, one-dispatch integration, and bounded accepted receipt.
- `ui/server/routes/api/github/webhook.post.ts`: unchanged mounting/authentication boundary unless its response typing must expose the safe receipt.
- `ui/server/agent-control-plane.ts` and `ui/server/agent-management.ts`: continue to validate and atomically persist create/replace requests; no new mutation surface.
- `ui/app/components/operator/AgentManagementConsole.tsx`: form orchestration only; consumes shared catalogs and sends typed definitions through existing actions.
- Existing dependencies only: Zod, React, Agent Native actions, Vitest, Bun, and pnpm.

## Prior learnings applied

`docs/solutions/integration/github-webhook-library-without-http-route.md` establishes that library tests are insufficient when the mounted webhook endpoint is absent or unproven. U4 therefore requires signed requests through `ui/server/routes/api/github/webhook.post.ts`, plus observation of durable queue and replay behavior.

The previously delivered automation trigger configuration intentionally left conditions out until field/operator and AND/OR semantics were approved. This plan consumes that approved contract without broadening it into a generic automation DSL.

## Deferred / out of scope

Raw expressions; nested boolean groups; regex; JSONPath; user code or scripts; changed-file filters; title/body matching; schedule-trigger conditions; additional GitHub event types; JSON import; multi-repository agents; action/tool graph changes; multi-operator tenancy; new publication authority; and any condition capable of widening repository or execution policy.

## Open questions

No blocking questions remain. Future condition types must run a new requirements pass and extend the discriminated union; they must not be tunneled through an untyped catch-all field.

## Outcomes & Retrospective

Planning is complete. The approved requirements are traced to four independently verifiable units with a dependency graph. Implementation outcomes, unexpected behavior, final proof, and residual risks will be recorded here as each unit lands.

## Artifacts and Notes

- Requirements: `docs/brainstorms/2026-07-22-github-trigger-condition-filtering-requirements.md`
- Prior feature plan: `docs/plans/2026-07-22-feat-automation-trigger-configuration-plan.md`
- Webhook route lesson: `docs/solutions/integration/github-webhook-library-without-http-route.md`
- Persisted contracts: `ui/shared/agent-definition.ts`
- Operator projections: `ui/shared/agent-management.ts`
- Webhook integration: `ui/server/github-webhook.ts`
- Operator UI: `ui/app/components/operator/AgentManagementConsole.tsx`
- Tracker epic: `td-18bac8`; import receipt `5ee5306f-ff37-46e9-9f99-34ff15a013bb`.

## Revision History

- 2026-07-22: Initial full plan grounded in approved R1-R13 requirements and current implementation; imported U1-U4 into td.
