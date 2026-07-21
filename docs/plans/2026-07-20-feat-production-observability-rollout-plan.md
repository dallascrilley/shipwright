# Production observability rollout

**Date:** 2026-07-20
**Source:** `docs/plans/2026-07-21-shipwright-cursor-agents-parity-plan.md` §U6; `td-973da0`
**Goal:** Make the Phase 2 control plane restart-safe and observable without enabling unattended publication by default.

## Constraints

- Preserve the existing single-operator model and host-owned credential boundary.
- Store no prompts, credentials, raw targets, run output, or identifiers in metrics.
- New deployments remain inert until an operator explicitly selects a rollout stage.
- No paid infrastructure is provisioned or contacted in this worktree.
- Agent compute stays ephemeral through the existing pipeline runner.

## Current facts

- `AgentManagementService` currently creates a process-local `MemoryAgentControlPlaneStore` (`ui/server/agent-management.ts`).
- The JSON-backed `OperatorRunRegistry` already proves the state-directory, atomic-write, and mode-0600 persistence pattern (`ui/server/operator-runs.ts`).
- The queue and schedule state machines are deterministic libraries with intentionally absent process ownership (`ui/server/queue-dispatcher.ts`, `ui/server/schedule-runner.ts`).
- The deployed service currently probes the SSR root endpoint only (`deploy/deploy.sh`); it starts neither scheduler nor queue worker (`docs/deployment.md`).

## Implementation units

### U6.1 Durable control-plane state

**Requirements:** R5, R6

**Files:** `ui/server/agent-control-plane.ts`, `ui/server/agent-management.ts`, focused specs.

**Approach:** Add a mode-0600, atomic JSON `AgentControlPlaneStore` at `$SHIPWRIGHT_STATE_DIR/agent-control-plane.json`; validate every load and every commit against `agentControlPlaneSnapshotSchema`; use it only outside demo mode. Migrate existing in-memory behavior without changing action contracts.

**Tests:** Missing state returns an empty snapshot; save/load survives a fresh service instance; malformed state fails closed; write creates private parent/file modes.

### U6.2 Rollout-gated worker ownership

**Requirements:** R5, R8, R10

**Files:** `ui/server/control-plane-runtime.ts`, `ui/server/queue-runner.ts`, `ui/server/plugins/control-plane.ts`, environment template, focused specs.

**Approach:** Introduce a validated rollout stage: `disabled`, `test_only`, `dry_run`, `approval_required`, or `publish_allowed`. Default to `disabled`. The process owns one scheduler tick and one queue-dispatch loop only when enabled. Test-only permits operator test entries; dry-run and approval-required force `publish: false`; publish is possible only at `publish_allowed` and only for revisions already marked `publish_allowed`.

**Tests:** Disabled runtime does not schedule or dispatch; test-only rejects non-test work; dry-run cannot request publication; dispatcher recovers expired leases after restart.

### U6.3 Redacted readiness and metrics

**Requirements:** R6, R10

**Files:** `ui/server/control-plane-observability.ts`, `ui/server/routes/healthz.get.ts`, `ui/server/routes/readyz.get.ts`, `ui/server/routes/metrics.get.ts`, focused specs.

**Approach:** Expose liveness and readiness separately. Export Prometheus text metrics limited to aggregate queue states, oldest active lease age, lifecycle trigger outcomes, terminal outcomes, paused circuit breakers, and dispatch latency. Reject any metric value containing unsafe text; never create labels from agent, target, run, trigger, or credential data.

**Tests:** Healthy and unavailable readiness paths; expected count/value output; identifiers, target URLs, prompts, tokens, and credentials cannot appear.

### U6.4 Deployment and operator runbook

**Requirements:** R5, R6, R8, R10

**Files:** `deploy/deploy.sh`, `deploy/shipwright.env.example`, alert rules, backup/restore helper, `docs/deployment.md`.

**Approach:** Validate production rollout configuration before service activation, probe `/healthz` and `/readyz`, install only redacted alert rules, and document staged activation, rollback, backup, and restore. Use a local backup/restore drill against the JSON store; do not provision a VM or monitoring service.

**Tests:** Shell/config validator accepts safe inert configuration and rejects active rollout without its required settings; backup/restore reproduces a valid snapshot; deploy static checks assert the readiness probe.

## Validation

1. Focused Bun and UI Vitest suites for every new storage/runtime/observability module.
2. `bun run typecheck` and `cd ui && pnpm typecheck`.
3. `bun run verify` after the final change.
4. Local production-mode smoke: start the UI with a temporary state directory and `SHIPWRIGHT_ROLLOUT_STAGE=disabled`; observe `/healthz`, `/readyz`, and `/metrics`; restart and prove persisted control-plane state is retained.

## Rollback

Set `SHIPWRIGHT_ROLLOUT_STAGE=disabled`, restart `shipwright`, and restore `agent-control-plane.json` from the latest verified backup. Existing operator-run receipts remain independent of control-plane-state rollback.
