# Shipwright operator console

This nested Agent Native app is Shipwright's operator console. The browser collects validated inputs and renders redacted run evidence; server Actions call the same host-owned pipeline used by the CLI.

## Local development

Requires Node 22 or newer and pnpm 10 or newer.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The operator is at `/`, and the agent management console is at `/agents`. Agent Native chat remains available at `/chat`.

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

### Agent management actions

All actions in this section are UI-only and unavailable to the in-app model, MCP, and A2A tool surfaces.

- `list-agents` / `get-agent`: return a searchable safe projection of agent status, configuration, triggers, queue history, redacted receipt evidence, and audit events. The list intentionally excludes instructions.
- `list-agent-repositories`: returns only GitHub App-accessible repositories that pass the host allowlist; archived repositories remain visible but unavailable.
- `create-agent` / `save-agent`: create a disabled draft and explicitly save later immutable revisions. Agent draft validation rejects secret-like values before they enter control-plane state or action responses.
- `create-agent-trigger` / `replace-agent-trigger` / `remove-agent-trigger`: add one of the four curated GitHub events or a validated schedule, atomically replace a GitHub trigger, or remove one active trigger at the expected revision. Persisted legacy GitHub actions remain readable, replaceable, and removable.
- `export-agent-definition`: returns the deterministic version-1, secret-free current configuration and trigger document used by **Copy as JSON**.
- `set-agent-enabled`, `set-schedule-trigger-paused`, and `emergency-stop-agent`: UI-only actions with explicit UI confirmation for agent enable, disable, and stop. Enabling requires an enabled, valid trigger.
- `queue-agent-test-run`: queues a dry-run test against the current revision and repository scope. It never activates a worker or publication path.

The management console uses the private file-backed transactional control-plane store outside demo mode. Demo mode intentionally uses the process-local adapter so local UI demonstrations never mutate host state.

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

`ui/server/github-webhook.ts` verifies GitHub HMAC signatures before parsing and
queues only bounded issue/PR target data for enabled, scoped triggers. It remains
library-only until U6 supplies the durable store and deploys the webhook endpoint.

`ScheduleScheduler` accepts five-field cron schedules with a valid IANA timezone
and a five-minute minimum interval, including across forward timezone changes.
It rechecks the actual cadence around each next persisted occurrence. Each trigger
pins a concrete issue/PR target to its revision scope, advances its persisted cursor
transactionally, and uses the
trigger plus scheduled occurrence for idempotency. It records schedule, skip,
trigger enablement, pause, resume, retry, stop, and circuit-breaker decisions; an
open per-agent failure circuit blocks every schedule trigger for that agent until
an operator resumes it. This remains library-only until U6 owns durable storage
and the production scheduler loop.

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
