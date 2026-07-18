# Programming Agent operator console

This nested Agent Native app turns the repository's GitHub issue programming-agent pipeline into a local operator console. The browser collects validated inputs and renders redacted run evidence; server Actions call the same host composition used by the CLI.

## Local development

Requires Node 22 or newer and pnpm 10 or newer.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The operator is at `/`. Agent Native chat remains available at `/chat`.

For deterministic UI work without GitHub, a model account, or Docker:

```sh
AGENT_PROGRAMMING_UI_DEMO=1 pnpm dev
```

Demo mode is dry-run only. Real runs use the root project's GitHub App, provider, Docker sandbox, verification, policy, receipt, and publication configuration.

## Actions

- `start-programming-run`: validates issue, verification, timeout, and publication confirmation inputs, then launches one background run.
- `get-programming-run`: reads a named run or the latest run after a browser refresh.
- `view-screen`: returns current navigation plus the latest redacted run state.
- `navigate`: changes the visible application route.

## Verification

```sh
pnpm test
pnpm typecheck
pnpm build
```

The run registry is intentionally local and single-operator. It prevents concurrent starts in one process; durable cross-restart resumption and multi-user tenancy are out of scope.
