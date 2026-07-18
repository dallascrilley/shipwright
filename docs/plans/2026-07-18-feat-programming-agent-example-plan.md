---
date: 2026-07-18
origin: user request in Codex task
base_branch: codex/agentos-starter
base_commit: b5bd1203aa962f2bf7e53ace65bc645568c17992
td_epic: none
---

# GitHub Issue to Pull Request Programming Agent

Living document. Update Progress, Surprises & Discoveries, Decision Log, Outcomes & Retrospective, and Revision History whenever implementation stops or a milestone changes direction. This repository does not currently have a `PLANS.md`; this file is self-contained.

## Purpose / Big Picture

Extend the committed agentOS Pi starter into a runnable programming-agent example. An operator supplies a GitHub issue URL. The program reads the issue through a GitHub App, checks out the target repository in an isolated full-toolchain sandbox, asks Pi to implement the issue, runs an independent verification command, and—only with an explicit publish flag—pushes a new branch and opens a pull request.

The finished example demonstrates the programming-agent claims directly: a native writable filesystem, git, shell commands, dependency installation, project tests, and GitHub pull-request delivery. GitHub credentials remain in host-controlled code. The agent sees the repository and sandbox tools but never receives an installation token.

## Progress

- [x] (2026-07-18 18:30Z) Inspected the committed agentOS starter at `b5bd120` and confirmed `bun run typecheck` passes.
- [x] (2026-07-18 18:30Z) Inspected the live AgentOS 0.2.7 package types, Pi package, sandbox integration, and current Warren GitHub patterns.
- [x] (2026-07-18 18:30Z) Chose the host-controlled GitHub App and mounted-sandbox architecture.
- [x] (2026-07-18 17:45Z) U1 implementation: Docker lifecycle, shared AgentOS workspace, bounded Pi session, command toolkit, cleanup, and opt-in real Pi fixture.
- [x] (2026-07-18 17:45Z) U2: GitHub App issue intake, exact allowlist authorization, repository-scoped installation token, and canonical-repository validation.
- [x] (2026-07-18 17:45Z) U3: guarded issue-to-change pipeline, independent verifier, publication policy, signal handling, and atomic redacted receipts.
- [x] (2026-07-18 17:45Z) U4: host-only commit/push, ephemeral askpass credentials, exact-diff recheck, and idempotent pull-request creation.
- [ ] U5 proof: deterministic suite, typecheck, and real Docker lifecycle pass; real Pi edit/test is blocked by model-account state, and live GitHub proof awaits an explicitly configured disposable issue and App installation.

## Requirements

- R1. Accept one canonical GitHub issue URL and reject malformed URLs, pull-request URLs, inaccessible repositories, and issues outside the configured repository allowlist.
- R2. Authenticate as the existing GitHub App installation with least privilege; do not log, persist, interpolate into command arguments, or expose its private key or installation token to Pi.
- R3. Create one isolated workspace per run, check out the repository default branch, and create a unique `agent/issue-<number>-<run-id>` branch without force-pushing or reusing a foreign branch.
- R4. Run Pi through agentOS with writable project files plus shell and full sandbox toolchain access. Pi may inspect, edit, install dependencies, and run tests, but it must not publish GitHub changes itself.
- R5. Independently run the operator-selected verification command after Pi returns; never treat the agent's claim that tests passed as proof.
- R6. Refuse publication when verification fails, no diff exists, protected paths changed, the diff exceeds configured limits, or the repository/branch no longer matches the authorized run.
- R7. Default to dry-run. Publish only with `--publish`, then commit, push, and open one non-draft pull request that links the issue and records verification evidence.
- R8. Emit a redacted machine-readable run receipt containing the issue, base SHA, branch, changed files, verification command/status, commit SHA, PR URL when published, and failure phase when unsuccessful.
- R9. Clean up the agent session, VM, sandbox, temporary credential helper, and transient workspace on success, failure, signal, and timeout.
- R10. Provide deterministic unit/integration tests, one real local Pi edit/test proof, and one opt-in live GitHub App proof against a disposable repository owned by `dallascrilley` or `dallascrilleymartech`.

## Context and Orientation

The implementation base is `codex/agentos-starter` at `b5bd120`, not the unborn `main` checkout. The starter contains:

- `server.ts`: registers an agentOS actor with `@agentos-software/pi` 0.2.7.
- `client.ts`: chooses an Anthropic, OpenRouter, OpenAI, or Gemini provider, waits for the runner, writes Pi settings, creates a session, and proves a prompt round trip.
- `test/e2e.test.ts`: starts the real registry and client and requires `AGENTOS_ROUND_TRIP_OK`.
- `package.json` and `bun.lock`: Bun-based scripts and pinned AgentOS 0.2.7 dependencies.
- `README.md`: starter installation, run, and end-to-end instructions.

The repository has no Git remote and no `.todos/`. Implementation therefore produces local commits in this repository; the programming agent's live acceptance proof targets a separately configured disposable GitHub repository.

`/Users/dallascrilley/Code/warren-private` is reference material, not a dependency. Its shipped code uses `GITHUB_TOKEN`, host-side REST calls, webhook verification, run branches, and a dedicated PR-opening reap step. Installation-scoped GitHub App authentication is still roadmap work there. Reuse its separation between agent work and host publication, URL parsing, fetch injection, and explicit PR outcome reporting; do not copy its shared-token forwarding into this example.

## Key Technical Decisions

### Use agentOS Core with a mounted full sandbox for each run

The new entry point will create a per-run `SandboxAgent`, mount its filesystem into an `AgentOs` VM with `@rivet-dev/agentos-sandbox`, and expose sandbox process tools to Pi. This is the narrowest design that supplies a real package manager and arbitrary project toolchain while preserving agentOS isolation. The existing actor-based starter remains as the minimal round-trip example; shared provider selection moves to a reusable module.

The rejected lightweight alternative was to run git, package installation, and tests entirely in the agentOS Wasm environment. AgentOS 0.2.7's default common software contains POSIX utilities but not git or a general project toolchain, and the current `build-essential` meta-package is a release candidate. That makes a generic issue fixer brittle.

### Keep GitHub authentication and publication on the host

Host code creates the GitHub App JWT and short-lived repository-scoped installation token. Host code uses the token only while fetching issue/repository metadata and while performing clone/push/API publication in the sandbox. The token is supplied through a temporary askpass mechanism or process environment, never embedded in a URL or command string, and the helper is removed before Pi starts.

The rejected Warren-style alternative forwards `GITHUB_TOKEN` into the worker. It is smaller, but an untrusted issue or repository could induce the agent to reveal or misuse the write token. The rejected GitHub-Git-Data-API alternative keeps credentials out of the sandbox but requires reimplementing git tree, mode, deletion, binary, and rename semantics.

### Make the CLI manual and dry-run by default

V1 is invoked as:

```sh
bun run programming-agent -- https://github.com/OWNER/REPO/issues/123 \
  --verify "bun test" \
  --publish
```

Without `--publish`, the program completes the edit and verification pipeline, writes a receipt, prints the diff summary, and exits without a remote branch or PR. Webhook intake, issue labels, queues, retries across process restarts, automatic merge, deployment, and issue comments are deferred. This keeps the example focused on the requested issue-to-PR path and makes accidental external writes unlikely.

### Use an explicit verification command

`--verify` is required for V1. The command runs inside the isolated sandbox after Pi stops. It receives a fixed timeout, has bounded captured output, and its real exit status controls publication. Automatic package-manager detection is deferred because guessing the authoritative gate is unsafe across arbitrary repositories.

### Enforce publication policy outside the prompt

Prompt instructions are guidance, not security controls. Host code rejects changes to `.git/**` and `.github/workflows/**` by default, rejects more than 100 changed files or 1 MiB of patch text, rejects an empty diff, and confirms the checked-out base SHA and generated branch immediately before commit/push. CLI flags may tighten these limits but cannot disable protected paths in this example.

## Interfaces and Dependencies

Add direct dependencies through Bun and commit the resulting `bun.lock`:

- `@rivet-dev/agentos-core` 0.2.7 for per-run VM lifecycle and host-directory mounts.
- `sandbox-agent` 0.4.x plus Docker peers for the isolated full-toolchain runtime; AgentOS Core's native host-directory mount projects the exact same per-run temp directory into Pi.
- `@octokit/app` and `@octokit/rest` for GitHub App JWT/installation authentication and typed REST calls.
- `zod` for environment, CLI input, GitHub payload, policy, and receipt schemas.

Required host environment:

- One existing model key supported by the starter and optional `AGENTOS_PROVIDER`.
- `GITHUB_APP_ID`.
- Exactly one of `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`; the path form is preferred.
- Optional `GITHUB_APP_INSTALLATION_ID`; otherwise resolve the installation for the target repository as the App.
- `GITHUB_REPOSITORY_ALLOWLIST`, a comma-separated list of exact `owner/repo` names. No wildcard or all-repositories default.
- Docker available for the local sandbox provider.

The GitHub App needs repository metadata read, issues read, contents write, and pull requests write. It does not need administration, members, secrets, actions, checks, or workflows permissions. The App should be installed only on selected repositories. If future scope allows changing workflow files, that must be a separate reviewed permission and policy change.

Core TypeScript interfaces:

```ts
interface IssueRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

interface IssueContext extends IssueRef {
  title: string;
  body: string;
  defaultBranch: string;
  baseSha: string;
  installationId: number;
}

interface RunRequest {
  issueUrl: string;
  verifyCommand: string;
  publish: boolean;
}

interface RunReceipt {
  runId: string;
  phase: "intake" | "workspace" | "agent" | "verify" | "policy" | "publish" | "complete";
  issue: IssueRef;
  baseSha?: string;
  branch?: string;
  changedFiles: string[];
  verification: { command: string; exitCode: number | null; passed: boolean };
  commitSha?: string;
  pullRequestUrl?: string;
  errorCode?: string;
}
```

`GitHubClient`, `SandboxClient`, and `ProgrammingAgent` must be injected behind narrow interfaces so unit and integration tests never need live GitHub, Docker, or an LLM.

## Plan of Work

### U1. Per-run sandbox and Pi coding loop

**Requirements:** R3, R4, R5, R9.

**Files:** Modify `package.json`, `bun.lock`, `client.ts`, and `README.md`. Create `programming-agent.ts`, `src/config/provider.ts`, `src/sandbox/runtime.ts`, `src/agent/prompt.ts`, `src/agent/runner.ts`, `test/agent/prompt.test.ts`, `test/sandbox/runtime.test.ts`, and `test/programming-agent-local.e2e.test.ts`.

Extract the starter's provider selection and Pi settings into `src/config/provider.ts` without changing the existing round-trip behavior. Build a lifecycle owner that starts one Docker sandbox, checks out a caller-provided local fixture into `/workspace`, mounts that workspace into a per-run `AgentOs` VM, creates Pi with `cwd: "/workspace"`, streams bounded progress, and disposes all resources in `finally` and signal handlers.

The prompt includes the issue title/body, exact verification command, working directory, and explicit boundary: inspect applicable agent instructions; implement only the issue; run tests while working; do not commit, push, open PRs, or reveal environment data. The issue body is delimited as untrusted task content.

**Tests:** A deterministic fake-agent test proves the lifecycle order and cleanup on every failure phase. A real opt-in Pi test starts from a tiny local TypeScript repository with one failing test, gives Pi the matching issue text, and asserts the independent verification command changes from nonzero to zero and the expected source file changes. The test must not use GitHub or publish anything.

**Verification:** `bun test test/agent test/sandbox test/programming-agent-local.e2e.test.ts` with the configured model key, followed by `bun run typecheck`.

### U2. GitHub App intake and authorization

**Requirements:** R1, R2, R3.

**Files:** Create `src/github/config.ts`, `src/github/issue-ref.ts`, `src/github/app-client.ts`, `src/github/git-auth.ts`, `src/github/types.ts`, `test/github/issue-ref.test.ts`, `test/github/config.test.ts`, `test/github/app-client.test.ts`, and `.env.example`. Modify `.gitignore` and `package.json`.

Parse only `https://github.com/<owner>/<repo>/issues/<positive-integer>` with no extra path. Normalize owner/repo case only for allowlist comparison while retaining GitHub's returned canonical names. Fetch repository metadata and the issue, reject payloads with a `pull_request` field, resolve the installation, mint a token restricted to the single target repository and required permissions, and record the default branch plus immutable base SHA.

Implement credential use as a callback such as `withInstallationToken(issueRef, fn)` so token scope cannot escape the host adapter. Redact authorization headers, JWTs, PEM text, askpass output, and token-shaped values from thrown errors and receipts. Tests use injected Octokit/request fakes and verify requested repository/permission scopes, allowlist enforcement, redaction, and token callback lifetime.

**Verification:** `bun test test/github` and `bun run typecheck`.

### U3. Guarded issue-to-change pipeline

**Requirements:** R3, R4, R5, R6, R8, R9.

**Files:** Create `src/pipeline/run.ts`, `src/pipeline/policy.ts`, `src/pipeline/receipt.ts`, `src/pipeline/errors.ts`, `src/cli/args.ts`, `src/cli/main.ts`, `test/pipeline/run.test.ts`, `test/pipeline/policy.test.ts`, `test/pipeline/receipt.test.ts`, and `test/cli/args.test.ts`. Modify `programming-agent.ts`, `package.json`, `.gitignore`, and `README.md`.

Add the CLI with required issue URL and `--verify`, optional `--publish`, and bounded `--timeout-minutes`. Create a cryptographically random short run ID and branch name. The host clones the exact default branch and captures its SHA before the VM starts. After Pi returns, the host runs the verification command independently, gathers `git status --porcelain=v1 -z`, changed paths, and bounded diff output, then applies publication policy.

Write receipts atomically under `.artifacts/programming-agent/<run-id>/receipt.json`; gitignore `.artifacts/`. On failure, write a redacted receipt before cleanup and return a stable nonzero exit code. Logs should be human-readable but every completion claim must derive from the receipt's observed command exit status and git state.

**Tests:** Table tests cover every failure phase, timeout, signal cleanup, no-op changes, protected paths, too many files, oversized patch, failed verification, stale base, and dry-run success. Integration tests use fake GitHub and sandbox adapters around a real temporary git repository.

**Verification:** `bun test test/pipeline test/cli` and `bun run typecheck`.

### U4. Host-only commit, push, and pull-request publication

**Requirements:** R2, R3, R6, R7, R8, R9.

**Files:** Create `src/github/publisher.ts`, `src/github/pull-request.ts`, `test/github/publisher.test.ts`, `test/github/pull-request.test.ts`, and `test/programming-agent-publish.integration.test.ts`. Modify `src/pipeline/run.ts`, `src/pipeline/receipt.ts`, `.env.example`, and `README.md`.

After policy passes and only when `publish` is true, configure a bot identity in the sandbox repository, commit only the already-inspected worktree, and push the unique branch with a fresh installation token. Use an ephemeral askpass helper or equivalent credential callback, disable interactive prompts, delete the helper immediately, and assert command output contains no credential. Never force-push.

Create a non-draft PR through Octokit with the issue title, `Fixes #<number>`, base branch, verification command/result, run ID, and changed-file summary. If the branch push succeeds but PR creation fails, preserve the branch and report `publish_pr_failed` with the branch name so rerunning publication can reconcile rather than duplicate. Before creating, query for an existing open PR with the same head/base; return it if its head SHA matches, otherwise fail closed.

**Tests:** Inject git command and Octokit fakes. Prove no push occurs before verification/policy, tokens are absent from command strings and receipts, retry returns the existing matching PR, mismatched existing branches fail, and PR bodies contain the issue and verification receipt.

**Verification:** `bun test test/github test/programming-agent-publish.integration.test.ts` and `bun run typecheck`.

### U5. Full proof, documentation, and handoff

**Requirements:** R1 through R10.

**Files:** Modify `test/e2e.test.ts`, `README.md`, `package.json`, and this plan's living sections. Create `test/fixtures/issue-repo/` and `test/programming-agent-live.e2e.test.ts`.

Preserve the existing `AGENTOS_ROUND_TRIP_OK` smoke. Add a deterministic local end-to-end fixture and an opt-in live test gated by `PROGRAMMING_AGENT_TEST_ISSUE_URL` plus `PROGRAMMING_AGENT_LIVE_PUBLISH=1`. The live target must be a disposable repository in the configured allowlist and owned by `dallascrilley` or `dallascrilleymartech`. The test records the PR URL and head SHA, verifies the PR is open and references the issue, and does not merge. Automated closure/deletion is allowed only for a specifically named disposable fixture repository and an explicit cleanup flag.

Document App registration permissions, selected-repository installation, environment variables, Docker prerequisite, dry-run, publish, receipt fields, failure recovery, cleanup, and the security boundary. State clearly that this is a single-run example, not a webhook service or autonomous merge system.

**Verification:** `bun test`, `bun run typecheck`, the real local Pi proof, and one live publish proof. Then inspect the created PR through GitHub, confirm no secret appears in logs/receipt/diff, and record the PR URL and exact tested commit in Outcomes & Retrospective.

## Validation and Acceptance

The implementation is accepted only when all of the following are observed on the final implementation commit:

1. `bun run typecheck` exits 0.
2. `bun test` exits 0 without requiring GitHub, Docker, or an LLM for the deterministic suite.
3. The opt-in local Pi end-to-end test turns a known failing fixture test green, leaves a nonempty expected diff, and publishes nothing.
4. A dry run against the disposable GitHub issue fetches through the App, makes and verifies a change, writes a redacted receipt, and creates no remote branch or PR.
5. A live run with `--publish` pushes one unique branch and opens one non-draft PR whose head SHA equals the receipt's commit SHA and whose body links the issue and reports the verification command/result.
6. A deliberately failing verification command produces a nonzero exit, a `verify` failure receipt, no push, and no PR.
7. A deliberately protected `.github/workflows/` edit is blocked even if Pi says the work is complete.
8. Searching captured logs, receipts, git config, process arguments, and diffs finds no private-key material, JWT, installation token, or credential-bearing URL.
9. After success and injected failures, no agent session, AgentOS VM, Docker sandbox, temporary askpass helper, or test server remains running.

## Idempotence and Recovery

Dry runs are repeatable because they never publish. Published runs always use a unique branch derived from issue number plus run ID and never overwrite an existing ref. Each phase updates the receipt atomically. A rerun after a clone, agent, verification, or policy failure starts a fresh workspace. A rerun after push but before PR creation uses the preserved branch/commit receipt and reconciles an existing matching PR before attempting creation.

Cleanup is best effort but must not erase evidence needed to recover a pushed branch. Local workspaces and credential helpers are disposable; the remote branch is not deleted automatically. If the process loses its terminal after dispatching a command, implementation must reconcile that command's process/result before retrying rather than launching a duplicate build, push, or PR request.

Rollback for implementation changes is normal branch reversion. Rollback for a live proof means close the disposable PR and delete only its exact generated branch after verifying the PR number, repository, and head SHA; do not use wildcard branch cleanup.

## Worktree & Concurrency

- **worktree_slug:** `codex/programming-agent-example`
- **base:** `codex/agentos-starter` at `b5bd1203aa962f2bf7e53ace65bc645568c17992`
- **spine_owner:** one implementation agent; serialize all units because `package.json`, `bun.lock`, `src/pipeline/run.ts`, and `README.md` are shared spine files.
- **exclusive write surfaces:** all tracked files in this small repository, plus new `src/`, `test/`, `docs/plans/`, `.env.example`, and `.artifacts/` ignore entry.
- **active conflicts:** none observed. The starter worktree was clean; this plan is authored separately on `codex/plan-programming-agent`.

Do not implement in the unborn `main` checkout or in the existing starter worktree. Create the implementation worktree from the exact base commit. If that slug is occupied or a fresh claim touches the same surfaces, use `codex/programming-agent-example-b` and record the conflict here before editing.

## Deferred / Out of Scope

- GitHub webhook ingestion, signature verification, label triggers, queues, scheduled runs, and durable retry across host restarts.
- Issue comments, check runs, commit statuses, inline PR reviews, automatic merge, branch-protection bypass, deployment, and post-merge cleanup.
- Multiple concurrent repositories or runs in one process, organization tenancy, user OAuth, billing, quotas, and a web UI.
- Automatic verification-command discovery and arbitrary workflow-file edits.
- Replacing Warren's control plane or implementing Warren's planned GitHub App roadmap.

## Surprises & Discoveries

- Observation: the primary checkout is an unborn `main`, while the usable starter is a clean committed worktree on `codex/agentos-starter`. Evidence: `git worktree list --porcelain` and commit `b5bd120`.
- Observation: current AgentOS 0.2.7 package names differ from several public documentation examples; the installed starter uses `@rivet-dev/agentos` and `@agentos-software/pi`. Evidence: committed `package.json` and installed package exports.
- Observation: the default AgentOS common bundle supplies POSIX text/file tools but not git or a generic project toolchain. Evidence: `@agentos-software/common` 0.2.7 dependency manifest.
- Observation: Warren's current GitHub path is token-based and its installation-scoped App auth remains planned. Evidence: `README.md`, `SPEC.md`, `src/pr-work/github.ts`, and `src/supervisor/git-credentials.ts` in `warren-private`.
- Observation: `sandbox-agent` 0.4.2 requires the optional `dockerode` and `get-port` peers, and its Docker provider does not auto-pull `rivetdev/sandbox-agent:0.5.0-rc.2-full`. Evidence: installed provider manifest/source and the real Docker smoke.
- Observation: the AgentOS 0.2.7 native sandbox filesystem plugin returns `EIO` while resolving ordinary mounted paths against the current sandbox-agent image. A per-run host temp directory bind-mounted into both Docker and AgentOS avoids that incompatible bridge. Evidence: direct mount probes failed on `realpath`, while the host-directory bridge passed Pi session setup and rejected a container-created `/etc/passwd` symlink with `path escapes host directory`.
- Observation: real Pi reached each configured provider, but OpenAI rejected the host key, both Anthropic entries reported insufficient credit, and OpenRouter rejected available endpoints under its privacy guardrail. No provider policy was weakened. Evidence: opt-in local Pi test attempts on 2026-07-18.

## Decision Log

- Decision: extend the committed starter rather than the empty primary checkout. Rationale: it preserves the already-proven Pi/AgentOS round trip and package pins. Date/Author: 2026-07-18 / Codex.
- Decision: use a mounted Docker sandbox and AgentOS Core per run. Rationale: arbitrary repositories need a real package manager and native toolchain, while a per-run lifecycle makes cleanup and dynamic workspaces explicit. Date/Author: 2026-07-18 / Codex.
- Decision: keep GitHub App tokens host-side and publish after verification. Rationale: issue/repository text and model output are untrusted; a write token in the agent session would make prompt injection a remote-write path. Date/Author: 2026-07-18 / Codex.
- Decision: require `--verify` and default to dry-run. Rationale: the authoritative test command cannot be inferred safely for every repository, and external publication should be unmistakably intentional. Date/Author: 2026-07-18 / Codex.
- Decision: use the existing Warren installation/configuration if available, but not Warren's shared-token implementation. Rationale: the user authorized that App surface; the codebase itself does not yet contain a reusable GitHub App client. Date/Author: 2026-07-18 / Codex.
- Decision: bridge the repository with one lifecycle-owned host temp root mounted into Docker and AgentOS, instead of the incompatible sandbox filesystem plugin. Rationale: both runtimes operate on the same isolated bytes, the host mount blocks symlink escape, and cleanup has one exact target. Date/Author: 2026-07-18 / Codex.

## Outcomes & Retrospective

Implementation commit `6914a0e` completes the CLI, sandbox/Pi lifecycle, GitHub App adapter, guarded pipeline, host-only publication, tests, and operator documentation. Fresh final evidence: 36 deterministic tests passed with four explicitly skipped live gates; strict TypeScript checking passed; the real Docker lifecycle passed and left no container or temp workspace; secret/diff checks passed; and the host-directory mount blocked symlink escape. Code review found no remaining blocking issue after fixes for credential cleanup, signal cleanup, canonical allowlist redirects, publication TOCTOU, and temp-directory permissions. Real Pi publication remains unverified because no configured model account can currently complete a prompt, and live GitHub publication remains unverified because Warren has no reusable GitHub App configuration and no disposable issue URL was supplied.

## Revision History

- 2026-07-18: Initial evidence-backed implementation plan created from the committed AgentOS starter, current package contracts, official AgentOS/GitHub security guidance, and Warren's shipped GitHub patterns.
- 2026-07-18: Updated implementation status, recorded the sandbox-filesystem incompatibility and host-directory bridge, and documented the external proof blockers.
