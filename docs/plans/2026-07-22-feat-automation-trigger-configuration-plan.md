---
date: 2026-07-22
origin: docs/brainstorms/2026-07-22-automation-trigger-configuration-requirements.md
td_epic: td-c4c766
---

# Automation trigger configuration plan

Living document. Update Progress, Surprises & Discoveries, Decision Log, Outcomes & Retrospective, and Revision History whenever implementation stops or a decision changes.

**Summary:** Complete Shipwright's existing Agents control plane with a GitHub App-backed repository selector, curated issue and pull-request triggers, safe legacy-trigger handling, and a versioned copyable JSON definition. Preserve disabled-by-default agents, dry-run-first behavior, host-side credentials, immutable revisions, and dispatch-time authorization.

## Purpose / Big Picture

After this work, an operator can create or edit an agent without typing a repository or GitHub webhook action by hand. The repository selector shows only repositories accessible to the configured GitHub App and allowed under `dallascrilley/*` or `dallascrilleymartech/*`. Trigger rows use readable choices such as **Issue created** and **Commits pushed to pull request**, the agent's instructions remain explicit, and **Copy as JSON** produces a stable secret-free definition. Existing trigger records remain readable and removable even when they contain a legacy raw action.

The manual Operator console remains unchanged. New agents remain disabled, test runs remain available before activation, and `dry_run` remains the default publication policy.

## Progress

- [x] (2026-07-22 14:49Z) Grounded the plan in current `origin/main`, the approved requirements, relevant tests, and the installed Octokit App API.
- [x] (2026-07-22 14:49Z) Resolved repository-catalog refresh, legacy-trigger compatibility, and condition-scope questions as planning decisions.
- [x] (2026-07-22 14:49Z) Imported epic `td-c4c766` with U1 `td-d39f87`, U2 `td-d77115`, U3 `td-997e46`, and U4 `td-137fbf`; verified the dependency graph.
- [ ] U1: Add the allowed-and-accessible repository catalog and enforce it at agent create/save boundaries.
- [ ] U2: Add curated GitHub trigger choices, trigger removal, legacy compatibility, and versioned JSON projection.
- [ ] U3: Replace free-form repository/action inputs with the repository picker and readable trigger editor.
- [ ] U4: Align deployment configuration and documentation, then prove the flow locally and in the deployed operator UI.

## Surprises & Discoveries

- Observation: The requested owner-scoped authorization is already implemented on `origin/main` by commit `6d5d42f`; `src/config/github.ts` accepts exact repositories and `owner/*` scopes. Evidence: `test/config/github.test.ts` covers both forms, while `.env.example` and `deploy/shipwright.env.example` still name only `dallascrilley/shipwright` and `README.md` still incorrectly says wildcards are rejected.
- Observation: Phase 2 is substantially delivered, not merely planned. Evidence: `ui/shared/agent-definition.ts`, `ui/server/agent-control-plane.ts`, `ui/server/github-webhook.ts`, `ui/server/schedule-runner.ts`, and `ui/app/components/operator/AgentManagementConsole.tsx` provide durable agents, signed triggers, schedules, queueing, and the management console.
- Observation: The existing UI is the remaining product gap. Evidence: `AgentManagementConsole.tsx` uses a free-form repository input plus raw `issues` / `pull_request` and comma-separated action fields.
- Observation: Trigger creation exists, but no public control-plane operation removes or replaces a trigger. Existing raw action strings therefore require an additive compatibility path rather than a schema-narrowing migration.
- Observation: `@octokit/app` already exposes `app.eachRepository.iterator()` in the installed version, so repository discovery needs no dependency change.
- Observation: The repository's shared `td` database resolves from the primary checkout; the linked worktree contains only copied diagnostic files. Tracker commands for this plan must use `td -w /Users/dallascrilley/Documents/shipwright` or the equivalent explicit work directory.

## Requirements

- **R1. Owner-scoped repository authorization.** Permit repositories owned by `dallascrilley` or `dallascrilleymartech`, preserve exact repository entries, and reject repositories outside the configured scopes.
- **R2. Accessible repository selection.** Agent create/edit uses a searchable selector containing only GitHub App-accessible repositories allowed by R1; catalog failure fails closed with an actionable message.
- **R3. Start-time reauthorization.** Test, triggered, and manual runs re-resolve the canonical repository and current authorization before work begins.
- **R4. Persistent agent configuration.** Retain the selected repository and optional branch, instructions, skill, tools, verification and publication policies, enabled state, triggers, and immutable revision link from executions.
- **R5. Curated GitHub triggers.** Offer **Issue created** (`issues.opened`), **Issue edited** (`issues.edited`), **Pull request created** (`pull_request.opened`), and **Commits pushed to pull request** (`pull_request.synchronize`) without raw webhook entry.
- **R6. Readable trigger editing.** Render triggers as concise event-and-repository sentences; allow multiple supported triggers and safe removal or replacement without rewriting history.
- **R7. Explicit instructions.** Keep required agent instructions prominent and make revision pinning clear.
- **R8. Versioned JSON representation.** Produce a stable, secret-free JSON representation that round-trips current configuration and triggers without loss.
- **R9. Safe activation and execution.** Preserve disabled-by-default creation, test-before-enable, dry-run default, and all existing publication gates.
- **R10. Trigger safety and evidence.** Preserve signature verification, idempotency, repository scope, dispatch-time authorization, bounded metadata, and redacted evidence.
- **R11. Condition-ready trigger boundary.** Keep an additive trigger-scoped extension point for a later typed condition model while unconditional triggers retain their current meaning.

## Decision Log

- Decision: Extend the installed Octokit App transport with repository iteration and expose a dedicated read-only repository-catalog action. Rationale: it reuses authenticated host-side App access, adds no dependency, and keeps credentials out of the browser. Date/Author: 2026-07-22 / Codex.
- Decision: Do not persist a second repository catalog. Fetch on Agents-page entry and explicit refresh; allow the client query cache to prevent duplicate rendering requests. Rationale: availability changes are authorization-relevant, and a durable cache could present revoked repositories as selectable. Date/Author: 2026-07-22 / Codex.
- Decision: Validate repository selection again inside agent create/save service boundaries, not only in the picker. Rationale: browser options are not an authorization boundary. Existing saved agents remain viewable when catalog loading fails, but a repository change or new agent cannot be saved until validation succeeds. Date/Author: 2026-07-22 / Codex.
- Decision: Keep the broad persisted GitHub trigger schema for backward compatibility, while new creation accepts only the four curated event/action pairs. Rationale: narrowing the snapshot schema would make existing records unloadable and could stop the control plane. Date/Author: 2026-07-22 / Codex.
- Decision: Unsupported legacy GitHub triggers render as clearly labeled read-only rows and can be removed; they are never silently rewritten. Rationale: this preserves current behavior and gives the operator an intentional migration path. Date/Author: 2026-07-22 / Codex.
- Decision: Add a versioned safe configuration projection and **Copy as JSON**, but no import or generic workflow action graph. Rationale: this satisfies portability and reviewability without turning Shipwright into a Cursor DSL clone. Date/Author: 2026-07-22 / Codex.
- Decision: Do not add a `conditions` field in this slice. Preserve the discriminated trigger boundary and plan conditions separately. Rationale: an unused or weakly validated condition field would imply behavior that does not exist. Date/Author: 2026-07-22 / Codex.

## Context and Orientation

`src/config/github.ts` owns exact and owner-scoped authorization. `src/github/app-client.ts` owns GitHub App authentication, installation permission checks, canonical repository resolution, issue/PR reads, and publication APIs. Its `GitHubTransport` is the test seam for adding an accessible-repository iterator.

`ui/shared/agent-definition.ts` owns persisted agent, revision, trigger, execution, queue, and version-1 snapshot schemas. GitHub triggers currently store `event: "issues" | "pull_request"` and a bounded array of identifier-safe action strings. Keep that persisted representation broad so old snapshots remain valid.

`ui/server/agent-control-plane.ts` performs transactional snapshot mutation and immutable revision/lifecycle recording. `ui/server/agent-management.ts` is the UI-facing service boundary. Agent create/save are currently synchronous and accept a free-form repository; implementation may make those two service methods asynchronous so they can validate against the live catalog before mutating the snapshot. `ui/server/github-webhook.ts` already matches exact event/action strings, verifies signatures, deduplicates deliveries, and enqueues only enabled matching agents.

`ui/actions/` contains one small Agent Native action per operator operation. Read-only UI-only actions set `readOnly: true`, `agentTool: false`, and `toolCallable: false`. Follow that convention for the catalog and JSON projection.

`ui/app/components/operator/AgentManagementConsole.tsx` owns the Agents index, configuration editor, trigger editor, test run, lifecycle controls, history, evidence, and audit presentation. It already uses `useActionQuery` and `useActionMutation`; keep the new repository query and trigger mutations in this component rather than introducing another page.

## Key technical decisions

- Repository options are normalized server-side to lowercase `owner/repository` identifiers and carry only display-safe metadata needed by the picker: canonical name, default branch, visibility, and archived state. Archived repositories may be displayed as unavailable but are not selectable for a new scope.
- Catalog results are the intersection of `app.eachRepository.iterator()` and `isRepositoryAllowed`. Empty installations, missing App configuration, API failures, and out-of-scope repositories return typed safe errors; they never fall back to a free-form field.
- New agent and repository-changing save operations must confirm that the selected canonical repository appears in a fresh catalog result. Saving unrelated fields on an existing agent may keep the unchanged repository when the catalog is temporarily unavailable, but test and dispatch authorization still recheck it.
- Curated trigger choices live in one shared constant/schema used by the action boundary, view-model labels, JSON projection, and UI. Do not duplicate event/action pairs in the component.
- Trigger removal is an optimistic-revision mutation. It removes only the selected active trigger record, appends a `trigger_removed` lifecycle event, and does not alter prior execution records or revision snapshots.
- The safe JSON projection is version `1`, orders triggers deterministically, includes current revision configuration and current trigger definitions, excludes audit IDs, queue state, receipts, raw webhook payloads, and secret bindings, and passes the existing secret-like-content guard before display or copy.
- No new package is needed. The only network dependency remains GitHub through the installed `@octokit/app` transport.

## Implementation units

### U1. Allowed repository catalog and save-boundary enforcement

- **Goal:** Return a live, deterministic list of GitHub App-accessible repositories permitted by current exact/owner scopes, then prevent new or changed agent scopes from bypassing that list.
- **Requirements:** R1, R2, R3, R4, R9, R10.
- **Files:** `src/github/app-client.ts`; `test/github/app-client.test.ts`; create `ui/shared/repository-catalog.ts`; create `ui/shared/repository-catalog.spec.ts`; create `ui/server/repository-catalog.ts`; create `ui/server/repository-catalog.spec.ts`; create `ui/actions/list-agent-repositories.ts`; modify `ui/server/agent-management.ts`, `ui/server/agent-management.spec.ts`, `ui/actions/create-agent.ts`, and `ui/actions/save-agent.ts`.
- **Approach:** Extend `GitHubTransport` with an App-level repository iterator backed by `app.eachRepository.iterator()`. Normalize, deduplicate, owner-filter, and sort safe repository summaries in a dedicated service. Inject that service into `AgentManagementService`; validate create and repository-changing saves before any control-plane mutation. Preserve deterministic injected fakes for tests and a non-secret demo catalog in `SHIPWRIGHT_UI_DEMO=1`. Expose a UI-only read action with safe failure codes and no credential-bearing causes.
- **Tests:** Exact allowlist entry; both approved owner scopes; foreign owner filtered; duplicate repository from repeated iteration; archived repository unavailable; default branch retained; missing/invalid GitHub configuration; GitHub API rejection redacted; create rejects a repository not in the catalog without writing an agent; repository-changing save rejects without creating a revision; unchanged repository save remains possible during temporary catalog failure; test/dispatch authorization continues to reject a now-disallowed repository.
- **Verification:** `bun test test/config/github.test.ts test/github/app-client.test.ts`; `cd ui && pnpm exec vitest run server/repository-catalog.spec.ts server/agent-management.spec.ts`; `bun run typecheck`; `cd ui && pnpm typecheck`.

### U2. Curated trigger lifecycle and safe JSON projection

- **Goal:** Make new GitHub trigger definitions unambiguous, preserve legacy records, support explicit removal, and expose a stable secret-free current-definition document.
- **Requirements:** R4, R5, R6, R7, R8, R10, R11.
- **Files:** `ui/shared/agent-definition.ts`; `ui/shared/agent-definition.spec.ts`; `ui/shared/agent-management.ts`; create `ui/shared/agent-management.spec.ts`; `ui/server/agent-control-plane.ts`; `ui/server/agent-control-plane.spec.ts`; `ui/server/agent-management.ts`; `ui/server/agent-management.spec.ts`; `ui/actions/create-agent-trigger.ts`; create `ui/actions/remove-agent-trigger.ts`; create `ui/actions/export-agent-definition.ts`.
- **Approach:** Add one shared four-choice trigger catalog and validate new GitHub trigger creation against exactly one supported event/action pair. Keep persisted `actions: string[]` parsing broad. Add an optimistic trigger-removal mutation and lifecycle event. Build a deterministic version-1 export view from the current revision plus active triggers, covering both GitHub and schedule triggers; classify unsupported GitHub combinations as legacy for display/export without changing them.
- **Tests:** All four supported pairs accepted and labeled; mixed or unsupported new pairs rejected; old snapshot with an unsupported action still loads; legacy trigger is classified without mutation; remove succeeds at the expected revision and records audit; stale revision and unknown trigger fail without mutation; prior executions retain their trigger/revision references; JSON serialize/parse equality; deterministic ordering; schedules preserved; instructions preserved; secrets, audit, queue, receipt, and raw payload fields absent.
- **Verification:** `cd ui && pnpm exec vitest run shared/agent-definition.spec.ts shared/agent-management.spec.ts server/agent-control-plane.spec.ts server/agent-management.spec.ts`; `cd ui && pnpm typecheck`.

### U3. Repository picker and readable trigger editor

- **Goal:** Let the operator configure agents using only accessible repository choices and readable triggers, with explicit instructions and copyable JSON.
- **Requirements:** R2, R4, R5, R6, R7, R8, R9, R11.
- **Files:** `ui/app/components/operator/AgentManagementConsole.tsx`; `ui/shared/repository-catalog.ts`; `ui/shared/agent-management.ts`; `ui/shared/agent-management.spec.ts`; `ui/README.md`.
- **Approach:** Query the repository catalog when the Agents surface loads and on explicit refresh. Replace the repository text input with a searchable filtered selector; use the selected repository's default branch when creating a draft. Keep an unavailable saved repository visible with a warning rather than substituting another option. Replace raw event/action fields with one curated trigger-choice selector and render trigger rows as sentences. Add remove/replace controls, retain the schedule editor, keep instructions above scope/policy fields, and add **Copy as JSON** with success/failure feedback. Disable new/repository-changing saves on catalog failure while leaving view, disable, stop, audit, and unchanged-repository edits operable.
- **Tests:** Pure view-model tests cover catalog loading/empty/error states, sorting/filtering, archived option state, unchanged unavailable repository, all four trigger sentences, legacy trigger warning, schedule description, and copy document shape. Existing Agent action tests cover mutation inputs and refresh behavior. Browser proof covers create, edit, remove/replace, copy, test run, enable confirmation, error recovery, and no raw event/action entry at desktop and 390 px.
- **Verification:** `cd ui && pnpm exec vitest run shared/repository-catalog.spec.ts shared/agent-management.spec.ts server/agent-management.spec.ts`; `cd ui && pnpm typecheck && pnpm build`; run the local UI and use the in-app browser to capture desktop and 390 px screenshots of a disabled agent with two readable triggers and the catalog-failure state.

### U4. Owner-scope rollout, documentation, and end-to-end proof

- **Goal:** Align checked-in configuration and production runtime with both approved owners, then prove repository selection and signed trigger dispatch without publishing.
- **Requirements:** R1, R2, R3, R5, R9, R10.
- **Files:** `.env.example`; `deploy/shipwright.env.example`; `README.md`; `docs/credentials.md`; `docs/deployment.md`; relevant deployment smoke tests under `test/deploy/` if the existing validator needs owner-scope coverage.
- **Approach:** Correct the stale README statement, update examples to `dallascrilley/*,DallasCrilleyMarTech/*`, and document that GitHub App installation access remains the upper bound. After code integration, update the host's non-secret allowlist configuration through the established deployment procedure, restart safely, and retain the prior exact value for rollback. Use a disposable repository target to verify catalog visibility, disabled draft creation, a dry-run test, and signed `issues.opened` plus `pull_request.synchronize` delivery. Do not enable `publish_allowed` and do not create an external write during proof.
- **Tests:** Example configuration parses both owner scopes; foreign owner remains rejected; deployment validator reports the expanded scope without printing credentials; signed fixture enqueues exactly one matching dry-run request and replay remains deduplicated; catalog and execution both fail after a test repository is removed from authorization.
- **Verification:** `bun test test/config/github.test.ts test/github/app-client.test.ts test/deploy`; `cd ui && pnpm test && pnpm typecheck && pnpm build`; `bun run verify`; deployed health/readiness checks pass; browser proof at `shipwright.dallascrilley.com/agents` shows repositories from both approved owners and no free-form GitHub action input; a redacted run receipt proves dry-run execution only.

## Worktree & concurrency

- **worktree_slug:** `feat/automation-trigger-configuration`
- **spine_owner:** self
- **Pre-flight:** from the Shipwright implementation worktree, run `git worktree list --porcelain`, `git status --short`, and check `.agents-state/worktrees.json` if it exists; compare every active Shipwright worktree against the write surfaces below. Worktrunk is not installed in the planning shell and this repository has no `.config/wt.toml`; use Git's native read-only listing unless the implementation environment adds a repository-local worktree manager. The available `~/.hub/scripts/worktree-posture.sh` is Hub-repository-specific and must not be used to create a false Shipwright claim.
- **Active conflicts:** none in the Shipwright repository. The only registered Shipwright worktrees at planning time are the primary checkout and this documentation worktree. Re-run the repository-local checks above before edits and use a suffixed slug if a fresh overlapping owner appears.

### Write surfaces

- **U1:** `src/github/app-client.ts`, `test/github/app-client.test.ts`, `ui/shared/repository-catalog.ts`, `ui/server/repository-catalog*`, `ui/server/agent-management*`, `ui/actions/list-agent-repositories.ts`, `ui/actions/create-agent.ts`, `ui/actions/save-agent.ts`.
- **U2:** `ui/shared/agent-definition*`, `ui/shared/agent-management*`, `ui/server/agent-control-plane*`, `ui/server/agent-management*`, `ui/actions/create-agent-trigger.ts`, `ui/actions/remove-agent-trigger.ts`, `ui/actions/export-agent-definition.ts`.
- **U3:** `ui/app/components/operator/AgentManagementConsole.tsx`, `ui/shared/repository-catalog*`, `ui/shared/agent-management*`, `ui/README.md`.
- **U4:** `.env.example`, `deploy/shipwright.env.example`, `README.md`, `docs/credentials.md`, `docs/deployment.md`, and narrowly required `test/deploy/` fixtures.

U1 and U2 can be developed in separate worktrees only if each claims its exclusive files and serializes shared writes to `ui/server/agent-management*` and `ui/shared/agent-management*`. U3 depends on both contracts and should integrate after them. U4 follows the merged U1-U3 head. A single sequential executor is the lowest-risk default.

## Plan of Work

Begin with U1 because the picker cannot be trustworthy without a server-owned catalog and save-boundary enforcement. Keep GitHub transport work isolated behind injected interfaces so unit tests never use live credentials. Commit U1 once focused root and UI server tests pass.

Implement U2 next without narrowing the persisted snapshot parser. Add the curated creation boundary, removal lifecycle, and export projection as one coherent domain slice. Use legacy fixtures before touching the UI so compatibility is proven independently.

Build U3 over the U1/U2 actions and view models. Reuse existing Agent Native action queries and the current console layout. Prove error and mobile states in a browser, not only through type checks.

Finish with U4. Correct repository documentation in the same branch, run the full local gate, integrate through the repository's normal PR flow, then update and verify the host configuration. Production activation is the final reversible step; do not use it to discover basic schema or UI errors.

## Milestones

### Milestone 1: Trusted repository selection

U1 is complete when an injected GitHub App iterator produces a sorted allowed catalog, new and repository-changing saves reject anything outside it without mutation, and exact/owner allowlists continue to pass focused tests.

### Milestone 2: Stable trigger and export contracts

U2 is complete when all four choices are accepted, unsupported new pairs fail, legacy persisted triggers still load and can be removed, and the version-1 safe JSON document round-trips in tests.

### Milestone 3: Operator workflow

U3 is complete when a browser user can select a repository, enter instructions, add readable triggers, copy JSON, test, and explicitly enable a disabled agent at desktop and 390 px, while catalog failure prevents unsafe scope changes.

### Milestone 4: Rollout proof

U4 is complete when examples and live non-secret configuration contain both approved owner scopes, the full local verification gate passes, the deployed selector shows accessible repositories from both owners, and a signed replay-safe event produces only a dry-run execution with redacted evidence.

## Concrete Steps

Run implementation from a fresh `feat/automation-trigger-configuration` worktree based on current `origin/main`. Start the first td child, claim the plan surfaces, and confirm a focused baseline before editing.

For each unit, write the listed scenario tests first, run the narrow command and observe the expected failure, implement only that unit's behavior, rerun the focused command, inspect the diff, and commit the unit with its td ID. Update this plan's Progress, Surprises & Discoveries, and Decision Log after every commit.

After U3, start the local UI and capture the required browser states. After U4 local verification, use the repository's normal reviewed PR path. Refresh checks and review state before any merge. Apply the live allowlist only from the reviewed integrated head, record the previous value without exposing it, and verify readiness plus the dry-run receipt.

## Validation and Acceptance

The implementation is accepted only when all R1-R11 mappings above are covered and these observable behaviors hold:

1. A new agent cannot type or submit an arbitrary repository; it selects an allowed App-accessible repository.
2. Repositories from both approved owners appear when their GitHub App installations grant access; a foreign owner never appears.
3. A GitHub outage or missing App configuration blocks new or changed repository scopes with an actionable safe error.
4. The four curated trigger labels produce the exact event/action pairs in R5; raw action input is absent.
5. A legacy unsupported trigger remains visible, labeled, and removable without preventing the snapshot from loading.
6. Instructions, repository, policies, schedules, and GitHub triggers survive JSON serialization and parsing; secrets and execution evidence do not enter the document.
7. Test run and trigger dispatch reauthorize the canonical repository; revocation stops execution.
8. Agents start disabled and `dry_run`; enable remains explicit and no proof run publishes.
9. Desktop and 390 px browser captures show the workflow without clipping, inaccessible labels, or hidden lifecycle warnings.

The final local gate is:

```sh
bun run verify
```

Read its terminal exit status and retain the focused test outputs from U1-U3. The production proof additionally requires current readiness/health output, the selected repository catalog state, a signed-event idempotency receipt, and a redacted dry-run receipt.

## Idempotence and Recovery

Repository listing is read-only and safe to retry. Catalog failure must not mutate agents. Agent create/save and trigger removal use the existing optimistic revision contract, so a stale client refreshes instead of overwriting newer state.

U2 is additive: keep the stored trigger parser broad and do not rewrite existing snapshots. If a new export or label projection fails, the underlying control-plane records remain unchanged. Trigger removal is intentional and audited; test it against a copied fixture before live use.

If deployment verification fails, restore the prior non-secret allowlist value and previous integrated application revision through the existing deployment procedure, restart, and rerun readiness. Do not alter GitHub App credentials or installation permissions as a rollback shortcut. Because this plan adds no database migration and does not rewrite existing trigger records, application rollback remains compatible with pre-change state.

## Interfaces and Dependencies

- `src/config/github.ts`: continue using `GitHubConfig`, `allowedRepositories`, `allowedOwners`, and `isRepositoryAllowed` as the single policy source.
- `src/github/app-client.ts`: extend `GitHubTransport` and `createOctokitTransport` for App-level repository enumeration; keep authorization functions unchanged except for shared safe types/helpers.
- `ui/shared/repository-catalog.ts`: own serializable repository option/result/error contracts used by the action and UI.
- `ui/server/repository-catalog.ts`: own configuration loading, transport injection, normalization, filtering, and safe error mapping.
- `ui/server/agent-management.ts`: enforce repository selection before mutation and expose removal/export operations over current control-plane state.
- `ui/shared/agent-definition.ts`: retain broad persisted trigger compatibility; add only shared curated-choice and lifecycle contracts required by U2.
- `ui/shared/agent-management.ts`: own readable trigger projection, legacy classification, and safe version-1 agent document.
- `ui/actions/`: remain small, UI-only action boundaries; no secrets or raw webhook payloads in responses.
- `ui/app/components/operator/AgentManagementConsole.tsx`: consume the contracts and keep UI orchestration; do not duplicate authorization or event/action mapping.
- Existing dependencies only: `@octokit/app`, `@octokit/rest`, Zod, React, Agent Native actions, Vitest, Bun, and pnpm.

## Prior learnings applied

No `docs/solutions/` entry covers repository catalogs or trigger configuration. `docs/solutions/integration/agent-native-chat-engine-provider.md` was reviewed and is unrelated to this action-driven operator surface. The plan therefore relies on the approved requirements, current implementation, and existing Phase 2 safety decisions rather than importing a mismatched chat-provider remedy.

## Deferred / out of scope

Typed condition editing/evaluation; arbitrary boolean expressions; JSONPath; user code hooks; changed-file filters; multi-repository agents; additional GitHub event types; JSON import; generic action/tool graphs; scheduled-trigger redesign; multi-operator tenancy; repositories outside the two approved owners; autonomous policy or instruction changes; and proof using `publish_allowed`.

## Open questions

No blocking questions remain. The condition field/operator matrix and AND/OR semantics belong to a separate requirements cycle. If implementation reveals that the installed GitHub App cannot enumerate both owner installations with current App credentials, record that as a deployment blocker rather than widening permissions or accepting typed repositories.

## Outcomes & Retrospective

Planning outcome: the approved requirements are mapped to four implementation units, planning-owned questions are resolved, and execution has not started. Replace this paragraph with delivered behavior, deviations, verification evidence, and residual risk when the plan completes.

## Artifacts and Notes

- Origin: `docs/brainstorms/2026-07-22-automation-trigger-configuration-requirements.md`
- Existing capability plan: `docs/plans/2026-07-21-shipwright-cursor-agents-parity-plan.md`
- Current UI: `ui/app/components/operator/AgentManagementConsole.tsx`
- Current persisted contracts: `ui/shared/agent-definition.ts`
- Current GitHub authorization: `src/config/github.ts` and `src/github/app-client.ts`

## Revision History

- 2026-07-22: Initial full plan grounded in current `origin/main`; scoped to the remaining catalog, trigger editor, JSON projection, and rollout work.
