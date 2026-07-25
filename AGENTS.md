# Shipwright — Agent Guide

Turn allowlisted GitHub issues into independently verified pull requests. The
repo has two layers that ship together: the root host pipeline/CLIs (Bun + tsx)
and the `ui/` Agent Native operator console (pnpm + Vite + React Router). See
`README.md` and `ui/DEVELOPING.md` for the authoritative command reference.

## Cursor Cloud specific instructions

Runtimes are managed by `mise` (`mise.toml` pins bun `1.3.14`, node `24.16.0`);
`pnpm` comes from corepack and resolves to `11.5.2` inside `ui/`. `mise` is
activated in `~/.bashrc`, so interactive shells already have `bun`/`node` on
PATH. In a non-interactive shell, prefix commands with `mise exec --` (or use
`$HOME/.local/bin/mise exec --`). The update script only refreshes dependencies
(`bun install` at root, `pnpm install` in `ui/`); it does not start services.

Dependencies live in two places: the root uses `bun` (`bun.lock`) and `ui/` uses
`pnpm` (`ui/pnpm-lock.yaml`). Run root scripts from the repo root; the `dev`,
`build`, `start`, and `verify` scripts already `cd ui` where needed.

Run the operator console (the primary dev surface) credential-free with
`SHIPWRIGHT_UI_DEMO=1 AUTH_DISABLED=true bun run dev`. It serves the Vite dev
server on `http://localhost:8080/` and applies SQLite migrations on startup.
Demo mode is dry-run only and needs no GitHub App, model key, or Docker — a
dry-run through the console exercises the full pipeline shape locally.

The full issue→PR pipeline (real runs, `--publish`, `test:docker`, `test:live`,
and the non-`--runtime-only` `bun run doctor` checks) additionally needs a
Docker daemon, the pinned sandbox image, a provisioned sandbox Bun, a model API
key, and a GitHub App private key. None of these are present by default in
Cloud, so `bun run doctor` intentionally FAILs the Docker/Sandbox lines and
`bun run doctor -- --runtime-only` is the meaningful readiness check here.

Verification needs no external services: `bun run verify` runs `bun test`,
root typecheck, and `ui` vitest + typecheck + build. Note root `bun test` also
executes the `ui/**/*.spec.ts(x)` files; the opt-in Docker/live/local-pi E2E
tests are skipped unless their env flags and credentials are set.

`.env` and `ui/.env` are gitignored and are NOT created by the update script.
Copy them from the `*.env.example` files (root `.env.example`, `ui/.env.example`)
and add real secrets before any live pipeline run.
