# Shipwright operator console

This nested Agent Native app is Shipwright's operator console. The browser collects validated inputs and renders redacted run evidence; server Actions call the same host-owned pipeline used by the CLI.

## Local development

Requires Node 22 or newer and pnpm 10 or newer.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The operator is at `/`. Agent Native chat remains available at `/chat`.

For deterministic UI work without GitHub, a model account, or Docker:

```sh
SHIPWRIGHT_UI_DEMO=1 pnpm dev
```

Demo mode is dry-run only. Real runs use the root project's GitHub App, provider, Docker sandbox, verification, policy, receipt, and publication configuration.

## Actions

- `start-shipwright-run`: validates issue/PR URL (or `fromRunId`), verify preset/`verifyCommand`, timeout, and publication confirmation; launches one background run. Review mode uses server-resolved `skillId` (default `fix-review-findings`); absolute skill paths are not stored on durable records.
- `list-verify-presets`: server-owned verification command presets.
- `resolve-target`: preflight a GitHub issue/PR URL for allowlist, title, and pinned head metadata before starting a run.
- `list-shipwright-runs` / `get-shipwright-run` / `cancel-shipwright-run`: history, detail, cancel.
- `view-screen`: returns current navigation plus the latest redacted run state.
- `navigate`: changes the visible application route.

Dry-run success offers **Start publish run (same inputs)** — a new publish run that reruns the agent (not an in-place promote). Demo mode refuses publish with a friendly error after confirm.

## Phase 2 control-plane and queue foundation

Agent definitions begin disabled. Each update creates an immutable revision; lifecycle
events record creation, configuration/policy changes, and enable/disable transitions.
Triggers pin their executions to the revision current at creation, and queue entries
retain that pinned revision; after an agent edit, replace a trigger to use the newer revision.

`QueueDispatcher` makes immutable, idempotent enqueue requests and moves them through
transactional lease states. Its pipeline adapter passes the lease-bound `AbortSignal`
and the pinned verification and publication policy to Shipwright's existing host-owned
pipeline. Triggers and background workers are not activated in this unit.

The dispatcher enforces each revision's repository scope at enqueue and immediately
before pipeline invocation. Issue/PR execution targets do not carry a ref, so branch
matching belongs to the U3/U4 trigger ingress that supplies one.

`approval_required` likewise runs dry until the U5 operator approval workflow can
create a separately confirmed publish execution.


`ui/server/agent-control-plane.ts` currently exposes an in-memory transactional adapter
for deterministic tests. The existing JSON run registry remains the P0 history adapter;
legacy runs have no `agentId` or `agentRevision`, while Phase 2 executions may carry both.
Replace the in-memory adapter with a durable transactional store before enabling triggers
or a production queue worker.

## Verification

```sh
pnpm test
pnpm typecheck
pnpm build
```

The run registry is intentionally single-operator. It prevents concurrent starts and persists records atomically under `SHIPWRIGHT_STATE_DIR`. On restart it reconciles a completed durable pipeline receipt before marking a genuinely unfinished run as interrupted; automatic resumption and multi-user tenancy remain out of scope.
