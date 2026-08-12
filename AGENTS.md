# Shipwright contributor guide

Instructions for anyone, human or agent, changing this repository. The
authoritative command reference is [README.md](README.md),
[CONTRIBUTING.md](CONTRIBUTING.md), and [ui/DEVELOPING.md](ui/DEVELOPING.md).

## Shape of the repository

Two layers ship together:

- The host pipeline and CLIs in `src/`, run with Bun and tsx, tested with
  `bun test` against `test/`.
- The Agent Native operator console in `ui/`, run with pnpm, Vite, and React
  Router, tested with vitest.

Dependencies live in two trees on purpose: root uses `bun.lock`, `ui/` uses
`ui/pnpm-lock.yaml`. Run root scripts from the repository root. The `dev`,
`build`, `start`, and `verify` scripts change into `ui/` themselves.

Runtime versions are pinned in `mise.toml` (bun, node) and `ui/package.json`
(pnpm). In a non-interactive shell with mise installed, prefix commands with
`mise exec --`.

## Verification

```sh
bun run verify
```

That is host tests, host typecheck, console tests, console typecheck, and
console build. It needs no GitHub App, no model key, and no Docker, and it is
exactly what `.github/workflows/ci.yml` runs. Never claim a change works without
running it.

Bun's test discovery is scoped to `test/` by `bunfig.toml`, so host tests go
under `test/` and console specs stay in `ui/`. The Docker, local-agent, and live
acceptance tests skip themselves unless their environment flags and credentials
are set.

The credential-free console loop:

```sh
SHIPWRIGHT_UI_DEMO=1 AUTH_DISABLED=true bun run dev
```

Demo mode is dry-run only and exercises the pipeline's shape locally. The full
issue-to-PR path, `--publish`, `test:docker`, `test:live`, and the non
`--runtime-only` `bun run doctor` checks additionally need a Docker daemon, the
pinned sandbox image, a provisioned sandbox Bun, a model API key, and a GitHub
App private key.

## Rules that are not negotiable

These are the reason the project exists. A change that weakens one needs to say
so in the pull request body, not slip through.

1. The sandbox never receives a GitHub credential or the host environment.
   `src/agent/runner.ts` builds the session environment explicitly. Adding a
   spread of `process.env` there defeats the entire design.
2. Every GitHub and git write happens in host code, after policy checks pass.
3. Publication requires an explicit human action every time: `--publish` on the
   CLI, a second confirmation in the console. Webhook triggers never grant
   publish authority.
4. Verification is independent. The repository's own command decides, and its
   real exit code goes into the receipt. Do not infer success from agent output.
5. Receipts record non-secret provenance only, written atomically at mode 0600
   through `writeReceipt`. Never add a field that could carry credential
   material.
6. Issue bodies, review comments, and webhook payloads are untrusted data. They
   are never instructions to the host.
7. No secrets, real credentials, private hostnames, or account identifiers in
   the tree, including fixtures. Use obvious placeholders.

## Conventions

TypeScript with `strict` on. Conventional Commits for subjects. Error messages
stay narrow and never echo credential material. When a change touches a command,
an environment variable, an entrypoint, or a deployment step, update the
affected documentation in the same change.
