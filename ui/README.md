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

- `start-shipwright-run`: validates issue, verification, timeout, and publication confirmation inputs, then launches one background run.
- `get-shipwright-run`: reads a named run or the latest run after a browser refresh or service restart.
- `view-screen`: returns current navigation plus the latest redacted run state.
- `navigate`: changes the visible application route.

## Verification

```sh
pnpm test
pnpm typecheck
pnpm build
```

The run registry is intentionally single-operator. It prevents concurrent starts and persists records atomically under `SHIPWRIGHT_STATE_DIR`. A service restart marks an unfinished run as interrupted; automatic resumption and multi-user tenancy remain out of scope.
