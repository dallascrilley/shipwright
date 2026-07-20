# Shipwright Bootstrap and Deployment

Living document. Update Progress, Surprises & Discoveries, Decision Log, Outcomes, and Revision History as work proceeds.

## Purpose / Big Picture

Rename the private `dallascrilley/rivet-test` proof project to Shipwright and turn it into a repeatable, private, single-operator service. After this work, an operator can bootstrap the repository with one command, diagnose missing prerequisites without exposing secrets, run the production UI on a dedicated Linux host, survive process restarts without losing completed run records, and use Kimi through AgentOS to turn an allowlisted GitHub issue into a verified pull request.

The deployed service remains intentionally single-operator. It does not become a public multi-tenant SaaS, autonomous merger, or webhook-driven queue.

## Progress

- [x] (2026-07-19 19:33 CDT) Merged the successful Kimi-generated PR #8 and confirmed issue #7 closed.
- [x] (2026-07-19 19:37 CDT) Audited current repository, hosting inventory, live host capacity, and production UI build behavior.
- [x] (2026-07-19 19:39 CDT) Selected a dedicated Hetzner Linux VM after existing shared hosts failed isolation or capacity gates.
- [x] (2026-07-19 20:00 CDT) Renamed current product, packages, CLI, UI copy, configuration paths, and operational documentation to Shipwright while retaining one documented CLI compatibility alias.
- [x] (2026-07-19 20:03 CDT) Added and exercised deterministic bootstrap and doctor commands, pinned runtime declarations, and deployment assets.
- [x] (2026-07-19 19:58 CDT) Persisted operator run records atomically and reconciled interrupted runs after restart, with focused tests.
- [x] (2026-07-19 20:06 CDT) Proved root/UI tests and typechecks, production build/start with HTTP 200, Docker sandbox access, shell validation, and restart persistence.
- [ ] Commit, push, review, merge, rename the GitHub repository, and create a clean local `shipwright` folder.
- [ ] Provision and deploy the private production service, configure secrets without printing them, and verify host plus end-to-end behavior.
- [ ] Update the infrastructure inventory and close all task-owned working state.

## Surprises & Discoveries

- Observation: the primary checkout at `/Users/dallascrilley/Documents/rivet-test` is an unborn `main` anchor with one untracked, user-owned `AGENTS.md`; all project history lives in linked worktrees. Evidence: `git worktree list --porcelain` and `git status --short` on 2026-07-19. The primary checkout must not be renamed while linked worktrees point into its `.git` directory.
- Observation: PR #8 was mergeable but had no CI checks. Evidence: `gh pr view 8`; focused provider tests and root typecheck passed before squash merge at `94b4c1f2c364f79252782b643194ac08ca0e1979`.
- Observation: no existing server is a safe landing zone. `rnpr-internal` had 1,088 MB available and 21 containers; `dokploy-ash-01` had 4,024 MB free disk at 95% use and 36 containers; `nodejs1870` had 59 MB available and no Docker; `automation-n8n` had 272 MB available and hosts production n8n.
- Observation: `pnpm build` succeeds, but the first `pnpm start` request returns HTTP 500 because Nitro externalizes `yjs` without putting it in the traced production package. Evidence: `ERR_MODULE_NOT_FOUND: Cannot find package 'yjs'` from `.output/server/_chunks/server.mjs`. `@agent-native/core@0.109.4` declares `yjs`, but `.output/server/package.json` omits it.
- Observation: building on macOS traces Darwin ARM native modules. Production must install and build on the target Linux x64 host rather than copying local `.output` artifacts.
- Observation: Corepack selects the UI's pinned pnpm 11.5.2 only when invoked with `ui/` as the working directory; `pnpm --dir ui` resolves the outer package manager first. Every root and deployment command now changes into the UI package explicitly.
- Observation: the original bootstrap root-path command substitution received duplicate path output from the local shell environment. Pure Bash parameter expansion fixed the failure and the complete bootstrap then passed.
- Observation: the first fresh review found that deployment switched releases before health proof and did not validate the GitHub App key path. The deploy transaction now runs the full doctor as the service user before activation and restores the previous release plus systemd unit on restart or health failure.

## Decision Log

- Decision: use the product name `Shipwright` and the repository slug `shipwright`. Rationale: the user approved the name. The npm name is already occupied, so all packages remain private and use scoped/internal names rather than publishing to npm. Date/Author: 2026-07-19 / Codex.
- Decision: preserve historical plan documents instead of rewriting their recorded project names. Rationale: those files are evidence of work performed under the old identity; current docs and executable surfaces will use Shipwright. Date/Author: 2026-07-19 / Codex.
- Decision: deploy to a dedicated Hetzner CX33-class x86 Linux VM in Helsinki rather than an existing shared host. Rationale: Shipwright needs Docker daemon authority to create sandboxes; sharing that authority with production workloads creates unacceptable blast radius. Helsinki x86 avoids ARM/native-module and sandbox-image compatibility risks. Date/Author: 2026-07-19 / Codex.
- Decision: cap infrastructure at approximately USD $11/month before tax, including IPv4, with no backups or add-on volumes initially. Rationale: current Hetzner pricing lists CX33 at USD $9.99/month excluding IPv4; the instance is deletable and billed hourly up to the monthly cap. Cheaper alternative: CX23, rejected because concurrent build/test sandboxes can exhaust 4 GB RAM. Owner: Dallas Crilley. TTL: review after 30 days. Teardown: delete the `shipwright` server and associated firewall after exporting `/var/lib/shipwright`. Monitoring: systemd status, disk/memory checks, Docker state, and the private service endpoint.
- Decision: run Shipwright as a host-level systemd service under a dedicated `shipwright` user in the Docker group. Rationale: the current sandbox runtime uses host filesystem bind paths; a nested application container would require a same-path host mount plus Docker socket access and would add failure modes without improving isolation on a dedicated VM.
- Decision: expose the UI privately through Tailscale Serve, bind the application to loopback, and keep Agent Native's normal Better Auth flow enabled. Rationale: version-matched Agent Native documentation explicitly forbids `AUTH_DISABLED` for production, even when another network boundary exists. No public ports or Cloudflare DNS change are needed for the initial deployment.
- Decision: store run registry state as an atomic JSON file under `SHIPWRIGHT_STATE_DIR`. Rationale: the service is single-process and single-operator; a transactional database would add operational weight without improving the stated concurrency model. On startup, incomplete records become failed/interrupted rather than silently remaining active.

## Outcomes & Retrospective

Pending implementation and deployment.

## Context and Orientation

The root TypeScript package contains the GitHub issue authorization, AgentOS/Pi execution, Docker sandbox, independent verification, receipt, commit, push, and pull-request pipeline. The nested `ui/` package is the Agent Native operator console. `ui/server/operator-runs.ts` currently owns an in-memory `Map`, which loses state on restart. `src/sandbox/runtime.ts` creates temporary host workspaces and starts Docker sandboxes. `.env.example` and `docs/credentials.md` document local credentials. `ui/netlify.toml` is a legacy UI-only deployment target and cannot run the Docker-backed pipeline.

The implementation worktree is `/Users/dallascrilley/Code/.worktrees/rivet-test/codex-shipwright-bootstrap-deploy` on branch `codex/shipwright-bootstrap-deploy`, based on `origin/main` commit `94b4c1f2c364f79252782b643194ac08ca0e1979`.

## Worktree & Concurrency

`worktree_slug`: `codex/shipwright-bootstrap-deploy`

This plan exclusively owns current product naming, root/UI package manifests and lockfiles, bootstrap/doctor/deploy scripts, run-registry persistence, deployment documentation, and the plan itself. Historical plans and proof receipts are read-only except for an optional one-line archival note. The user-owned primary `AGENTS.md`, unrelated worktrees, and the dirty `coolify-personal-hosting` checkout are off-limits.

## Plan of Work

First, rename current user-facing and executable surfaces to Shipwright while retaining a compatibility alias for the old CLI command long enough to avoid breaking saved commands. Change receipt/state directories to Shipwright names, with explicit environment overrides for production paths.

Second, add a bootstrap command that verifies Bun, Node, pnpm, Docker, and environment file shape before installing locked dependencies. Add a doctor command that reports names and pass/fail status only; it must never print secret values. Pin runtimes in a repository-supported version file and make local development, verification, production build, and production start invocable from the root package.

Third, replace the operator console's in-memory-only registry with an injectable atomic JSON store. Write failing tests for loading completed history, persisting progress, and reconciling an active record after restart. Keep execution serialization at one active run.

Fourth, add a production provisioning script and systemd unit. The host layout is `/opt/shipwright` for the checkout, root-owned group-readable files under `/etc/shipwright` for secrets, and `/var/lib/shipwright` for state, receipts, and workspaces. The application binds `127.0.0.1`; Tailscale Serve owns private HTTPS. Deployment builds on Linux x64 to match native dependencies.

Fifth, run root and UI tests, typechecks, builds, a production HTTP smoke, Docker sandbox smoke, and a restart-persistence smoke. Review the exact diff, commit and push, open and merge a pull request when green, then rename the GitHub repository. Clone the renamed repository to `/Users/dallascrilley/Documents/shipwright`; retain the old primary anchor until its linked worktrees are retired.

Finally, provision the VM within the recorded cost ceiling, transfer the reviewed commit as an immutable release, inject secrets from existing 1Password items, start the systemd service, enable Tailscale Serve, create the single operator account through Better Auth, and verify service status, private HTTPS, Docker sandbox creation, and one controlled Kimi issue-to-PR run against the renamed repository. Record the host in the canonical hosting inventory without absorbing unrelated dirt.

## Milestones

### Milestone 1: Rename and bootstrap

Result: all current surfaces say Shipwright; `bun run bootstrap` and `bun run doctor` work from a clean checkout; the legacy CLI alias remains documented as temporary compatibility.

Proof:

```sh
bun run bootstrap
bun run doctor
bun test
bun run typecheck
```

### Milestone 2: Durable operator runtime

Result: completed run records survive a registry/process restart, and an active record is reconciled to an explicit interrupted failure.

Proof:

```sh
bun test ui/server/operator-runs.spec.ts
cd ui && pnpm test && pnpm typecheck
```

### Milestone 3: Production packaging

Result: the Linux-target deployment files install locked dependencies, build the UI on-host, start under systemd, persist state outside the checkout, and return a successful HTTP response on loopback.

Proof:

```sh
cd ui && pnpm build
BETTER_AUTH_SECRET=<redacted> HOST=127.0.0.1 PORT=4317 pnpm start
curl -fsS http://127.0.0.1:4317/
RUN_DOCKER_E2E=1 bun test test/sandbox/docker.e2e.test.ts
```

### Milestone 4: Shipped and deployed

Result: GitHub identifies the private repository as `dallascrilley/shipwright`; the canonical local folder exists; the dedicated host serves Shipwright privately; a controlled Kimi run produces a verified remote pull request with a durable receipt.

Proof includes GitHub API state, exact deployed commit, systemd active state, Tailscale endpoint response, Docker sandbox test, durable state across restart, and the final pull-request URL/head SHA.

## Validation and Acceptance

Acceptance requires all deterministic root and UI tests passing; root and UI typechecks passing; production UI build and start returning HTTP 200; Docker sandbox E2E passing; state surviving restart; no secret values in git diff, logs, receipts, or docs; GitHub repository and local canonical folder using the Shipwright identity; production running the exact reviewed commit; and one post-deploy Kimi issue-to-PR proof.

## Idempotence and Recovery

Bootstrap and host provisioning must be rerunnable. Dependency installs use committed lockfiles. Directory creation uses fixed ownership and permissions. Deployment replaces the checkout only after a successful fetch/build, then restarts one service. A failed application deploy leaves the prior commit addressable through git and keeps `/etc/shipwright` plus `/var/lib/shipwright` untouched. Before any VM deletion, archive `/var/lib/shipwright` and remove Tailscale/DNS routes. If repository rename causes an integration problem, GitHub redirects the old URL while local remotes are updated explicitly.

## Interfaces and Dependencies

No new runtime service dependency is planned. The only direct package correction currently expected is `yjs@13.6.31` in `ui/package.json`, matching `@agent-native/core@0.109.4`, because Nitro's production tracer otherwise omits it. Production requires pinned Node 24.16.0, pnpm 11.5.2 through Corepack, Bun 1.3.14, Docker Engine, systemd, and Tailscale.

Environment additions:

- `SHIPWRIGHT_STATE_DIR`: persistent state root; defaults to `.artifacts/shipwright` locally.
- `HOST` and `PORT`: Agent Native listener, set to `127.0.0.1:4317` in production.
- `DATABASE_URL`: durable Agent Native SQLite database at `/var/lib/shipwright/agent-native.db`.
- `BETTER_AUTH_SECRET`: stable random value of at least 32 characters for production sessions.

Existing GitHub App and model variables retain their names. Their values stay in 1Password or the root-owned, `shipwright`-group-readable production environment file.

## Artifacts and Notes

- Original proof PR: `https://github.com/dallascrilley/rivet-test/pull/8`, merged as `94b4c1f2c364f79252782b643194ac08ca0e1979`.
- Hosting inventory source: `/Users/dallascrilley/.hub/artifacts/skills/hosting-infrastructure-operator/source/references/authoritative-inventory.md`.
- Official pricing evidence: Hetzner's 2026-06-15 cloud price adjustment lists CX33 in Germany/Finland at USD $9.99/month excluding IPv4.

## Revision History

- 2026-07-19: Created after name approval, live host audit, PR #8 merge, and first production-start reproduction.
