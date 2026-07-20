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

## Verification

```sh
pnpm test
pnpm typecheck
pnpm build
```

The run registry is intentionally single-operator. It prevents concurrent starts and persists records atomically under `SHIPWRIGHT_STATE_DIR`. On restart it reconciles a completed durable pipeline receipt before marking a genuinely unfinished run as interrupted; automatic resumption and multi-user tenancy remain out of scope.
