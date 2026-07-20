---
date: 2026-07-19
origin: user request in Codex task
---

# AgentOS PR Review Feedback Pipeline

Living document. Update Progress, Surprises & Discoveries, Decision Log, Outcomes & Retrospective, and Revision History whenever execution stops or a decision changes.

**Summary:** Add a trusted host-owned `review-agent` workflow that uses AgentOS Pi with Kimi and the canonical `fix-review-findings` skill to validate unresolved review threads on an existing same-repository pull request, make warranted edits in an isolated sandbox, independently verify them, push the exact PR branch, reply to every original thread, resolve completed threads, and preserve a redacted receipt. Demonstrate it on `DallasCrilleyMarTech/.hub#1029` without exposing GitHub or model credentials to the agent.

## Purpose / Big Picture

The existing programming agent proves issue-to-new-PR publication. It cannot update an existing PR because it authorizes only issue URLs, clones the default branch, and always creates a new branch and pull request. After this plan, an operator can pass a same-repository PR URL to a dedicated command and receive one correlated receipt covering the reviewed head, skill identity, changed files, independent verification, pushed commit, thread replies, resolution state, and cleanup.

## Progress

- [x] (2026-07-20 00:10Z) Confirmed PR #1029 is open, non-draft, mergeable, and at head `7a6078528e0659ab525d3cf45d52baae52973823` with four unresolved non-outdated threads and a changes-requested review.
- [x] (2026-07-20 00:18Z) Confirmed the current runner is issue-only and Pi's AgentOS adapter skips skill discovery on its fast path unless at least one extension is present.
- [x] (2026-07-20 00:20Z) Confirmed Pi supports Agent Skills under `~/.pi/agent/skills/`; selected trusted skill projection plus a no-op extension to force the supported resource loader.
- [ ] U1. Add tested PR reference parsing, authorization, thread reads, replies, resolution, and reconciliation.
- [ ] U2. Add tested skill projection, review prompt, structured outcome artifact, and sandbox PR-head operations.
- [ ] U3. Add the host-owned review pipeline, receipt, CLI, documentation, and deterministic verification.
- [ ] U4. Independently review and integrate the runner change into `dallascrilley/rivet-test`, then pin the live runner to that exact reviewed commit.
- [ ] U5. Run one bounded Kimi request against `.hub#1029`, reconcile receipt/head/threads, verify the exact remote head, audit secrets, and prove cleanup.

## Requirements

- R1. Accept a canonical GitHub PR URL only when its canonical repository is exactly allowlisted, the PR is open, and the head branch belongs to the same repository.
- R2. Pin the sandbox to the authorized PR head SHA and reject publication if the local or remote head moves.
- R3. Project the canonical `fix-review-findings` skill into Pi, force supported skill discovery, require the agent to read it, and record its SHA-256 digest without recording its contents or host path remotely.
- R4. Give Kimi the unresolved thread context and review body as untrusted content, never GitHub credentials or installation tokens.
- R5. Require exactly one validated outcome per unresolved thread: fixed, deferred with a follow-up, rejected with evidence, or needs-human.
- R6. Independently verify warranted code changes before commit/push. Permit a no-code run only when every outcome is rejected, deferred, or needs-human.
- R7. After a successful push or valid no-code result, reply on each original thread with the outcome and evidence. Resolve fixed, rejected, and concretely deferred threads; leave needs-human unresolved.
- R8. Make replies idempotent by embedding the run/thread marker and reusing a matching existing reply during recovery. Re-fetch thread state and fail if any thread expected resolved remains unresolved.
- R9. Preserve a mode-0600 redacted receipt containing execution, skill digest, PR URL, authorized head, changed files, verification, commit, reply URLs, resolution state, and intentionally open threads.
- R10. Use one foreground Kimi request, no automatic retry, existing membership quota only, and teardown the Pi session, sidecar, Docker sandbox, temporary token helper, and workspace on every terminal path.

## Key Technical Decisions

- Add a separate `review-agent` entrypoint. This keeps the proven issue-to-PR command backward compatible and makes PR-specific invariants explicit.
- Support same-repository PR heads first. Installation tokens can safely push that exact branch; fork-head authentication and repository-boundary rules are deferred.
- Keep GitHub writes host-owned. Kimi edits files and writes a structured local outcome artifact; the trusted host validates it, verifies the repository, pushes, replies, and resolves.
- Load the canonical skill from an explicit host path. Pi receives the bytes in its private agent directory and the receipt records only the SHA-256 digest.
- Treat review comments as hostile input. They are delimited in the prompt and cannot change publication, credential, or verification policy.

## Implementation Units

### U1. GitHub PR authorization and thread client

- **Goal:** Provide exact, testable PR/head/thread operations behind the GitHub App boundary.
- **Requirements:** R1, R2, R7, R8.
- **Files:** `src/github/pull-request-ref.ts`, `src/github/review-client.ts`, `src/github/types.ts`, `src/github/app-client.ts`, `test/github/pull-request-ref.test.ts`, `test/github/review-client.test.ts`.
- **Approach:** Parse canonical `/pull/<n>` URLs; authorize the repository before API access; read PR metadata, reviews, and GraphQL review threads; reject closed, fork-head, or moved targets; add marker-aware thread reply and resolve operations; re-fetch final state.
- **Tests:** Invalid URLs fail; outside-allowlist calls do not reach GitHub; fork/closed PRs fail; unresolved thread normalization preserves IDs/path/line/body; existing run markers suppress duplicate replies; resolve results are checked.
- **Verification:** `bun test test/github/pull-request-ref.test.ts test/github/review-client.test.ts`.

### U2. Pi skill projection and sandbox review artifacts

- **Goal:** Make the canonical workflow available to Pi and return a host-validated thread ledger without exposing credentials.
- **Requirements:** R3, R4, R5, R6, R10.
- **Files:** `src/agent/runner.ts`, `src/agent/review-prompt.ts`, `src/sandbox/runtime.ts`, `src/pipeline/review-outcomes.ts`, `test/agent/runner.test.ts`, `test/agent/review-prompt.test.ts`, `test/sandbox/runtime.test.ts`, `test/pipeline/review-outcomes.test.ts`.
- **Approach:** Add optional skill projections to the Pi runner, write them beneath the private Pi agent directory, install a no-op extension to activate `DefaultResourceLoader`, and require the review prompt to read `fix-review-findings`. The agent writes a JSON artifact outside the committed diff; the host removes and validates it before policy inspection.
- **Tests:** Skill projection occurs before session creation; prompt contains trusted workflow requirements and delimited hostile content; outcome validation rejects missing/duplicate/unknown threads, fixed-without-changes, and deferred-without-follow-up.
- **Verification:** `bun test test/agent test/sandbox test/pipeline/review-outcomes.test.ts`.

### U3. Review pipeline, receipt, CLI, and docs

- **Goal:** Orchestrate the complete safe workflow with durable recovery evidence.
- **Requirements:** R1-R10.
- **Files:** `review-agent.ts`, `src/cli/review-args.ts`, `src/cli/review-main.ts`, `src/cli/dependencies.ts`, `src/pipeline/review-run.ts`, `src/pipeline/review-receipt.ts`, `package.json`, `README.md`, matching tests.
- **Approach:** Authorize and snapshot PR/head/threads, clone the exact branch/head, project the skill, run one agent turn, validate outcomes, verify, inspect policy, commit/push only when changes exist, perform idempotent replies/resolutions, reconcile final thread state, write atomic receipt, and destroy the workspace in `finally`.
- **Tests:** Full mocked success with code changes; valid no-code rejection; verification failure prevents push/replies; head movement prevents push/replies; partial reply failure leaves recoverable receipt; abort after verification prevents all writes.
- **Verification:** `bun test && bun run typecheck`.

### U4. Runner integration

- **Goal:** Put the exact verified runner commit on `dallascrilley/rivet-test` `main` before the billable live run.
- **Requirements:** R2, R9, R10.
- **Files:** All U1-U3 files and this plan.
- **Approach:** Commit scoped changes, push a dedicated branch, open a PR, run an independent risk-scaled review, fix blockers, rerun tests/typecheck, merge the exact reviewed head, and use a clean worktree pinned to the resulting `origin/main` for U5.
- **Tests:** Fresh install, deterministic tests, typecheck, clean diff, secret scan.
- **Verification:** GitHub PR head equals reviewed commit; merge commit contains that tree; pinned runner worktree is clean.

### U5. Live `.hub#1029` proof

- **Goal:** Demonstrate the real PR-feedback workflow without a coordinator editing the target branch or manually replying/resolving threads.
- **Requirements:** R1-R10.
- **Files:** Generated `.hub` PR branch changes if Kimi validates findings; gitignored local receipt; this plan's proof section only.
- **Approach:** Confirm PR #1029 head and unresolved threads are unchanged; record one-request cost ceiling; inject existing Kimi and GitHub App credentials from 1Password without printing values; run `review-agent` once in the foreground with the canonical skill path and `.hub` verification command; reconcile receipt, remote head, replies, resolved threads, exact-head verification, secrets, and cleanup.
- **Tests:** The exact `.hub` PR head passes the requested focused contract tests and contract generator verification selected from repository evidence.
- **Verification:** Receipt, remote branch, PR head, reply markers, resolved state, verification, provider/model, skill digest, and cleanup all agree.

## Worktree & Concurrency

- **worktree_slug:** `codex/pr1029-review-feedback-demo`
- **spine_owner:** self
- **Pre-flight:** This worktree was created from `origin/main` at `530c41d`; the shared primary's untracked `AGENTS.md` remains untouched.
- **Active conflicts:** None observed in this dedicated worktree. The live `.hub` target branch is updated only by the trusted pipeline after an exact-head recheck.

### Write Surfaces

- U1: GitHub reference/client modules and tests.
- U2: Pi runner, prompt, sandbox artifact handling, outcome validation, and tests.
- U3: Review CLI/pipeline/receipt, package/docs, and tests.
- U4: This dedicated rivet-test branch and its PR only.
- U5: `.hub` PR #1029's existing head branch, original review threads, local receipt, and this plan.

## Deferred / Out of Scope

- Fork-head pull requests, merging PR #1029, submitting approvals, dismissing the existing changes-requested review, GitHub Actions setup, webhook/queue service, automatic retries, multiple model calls, and direct GitHub access from Kimi.

## Validation and Acceptance

Acceptance requires deterministic tests and typecheck on the runner, one independently reviewed runner commit integrated into `rivet-test` main, one foreground Kimi run, exact receipt-to-remote SHA correlation, one outcome and reply per original unresolved thread, no unintended unresolved threads, fresh verification on the resulting `.hub` head, no secret in durable/remote artifacts, and zero remaining runtime/sandbox/temp-workspace resources. PR #1029 remains open and unmerged.

## Idempotence and Recovery

Never relaunch while the foreground process or its continuation handle is live. On failure, inspect the receipt, remote head, and run markers before another model request. A pushed commit is never recreated manually. Existing marker replies are reused; unresolved marked threads can be resolved without duplicating replies. A retry is a new Kimi request and requires explicit new cost authority.

## Interfaces and Dependencies

No new package dependency is required. Existing `@octokit/app` and `@octokit/rest` provide repository, pull-request, review, and GraphQL operations. Existing AgentOS/Pi supports project/global Agent Skills; a trusted no-op extension activates the full resource loader in the current adapter.

## Outcomes & Retrospective

Pending implementation and live proof.

## Revision History

- 2026-07-19: Initial plan created from live PR #1029 evidence and current runner architecture.
