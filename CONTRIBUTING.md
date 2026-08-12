# Contributing

Thanks for looking. Shipwright is a small, single-maintainer project, so the
fastest path is usually an issue describing what you hit before you write code.

## Local setup

You need Bun, Node, and pnpm. The versions are pinned in `mise.toml` and
`ui/package.json`; [mise](https://mise.jdx.dev/) will install them, or install
them yourself.

Use the pinned Node version rather than whatever is newest. A transitive native
dependency fails to compile on Node 26, so `bun install` will exit during the
`isolated-vm` build step if you are ahead of the pin. CI uses the pinned
versions for the same reason.

```sh
bun install --frozen-lockfile
(cd ui && pnpm install --frozen-lockfile)
bun run verify
```

`bun run verify` is the full gate and needs no credentials, no Docker, and no
network beyond the install step. It is the same set of commands CI runs.

Dependencies live in two trees on purpose: the host uses Bun with `bun.lock`,
the console uses pnpm with `ui/pnpm-lock.yaml`. Run root scripts from the
repository root.

If you want the full runtime, `bun run bootstrap` also pulls the digest-pinned
sandbox image and provisions the sandbox Bun. It needs a running Docker daemon.

## Tests

| Command | Scope | Needs |
| --- | --- | --- |
| `bun test` | host suite, `test/` | nothing |
| `cd ui && pnpm test` | console suite, vitest | nothing |
| `bun run test:docker` | sandbox behavior | Docker, `RUN_DOCKER_E2E=1` |
| `bun run test:local-pi` | local agent run | Docker, model key, `RUN_LOCAL_PI_E2E=1` |
| `bun run test:live` | live issue-to-PR | Docker, model key, GitHub App |

Bun's test discovery is scoped to `test/` by `bunfig.toml` so it does not
collect the console's vitest specs under the wrong runner. If you add a host
test, put it under `test/`.

Live tests must target a disposable issue in a repository you own and have
explicitly configured. Do not point them at someone else's repository.

## What a change needs

- `bun run verify` green before you open the pull request.
- A test for behavior you changed. Guardrails especially: every security
  property claimed in the README is held to a named test, and a new guardrail
  without a test is not a guardrail.
- Documentation updated in the same change when you touch a command, an
  environment variable, an entrypoint, or a deployment step.
- No secrets, no real credentials, no private hostnames or account identifiers,
  including in fixtures. Use obvious placeholders.

## Style

TypeScript with `strict` on. Prefer explicit types at module boundaries and
narrow error messages that do not echo credential material. Commit subjects
follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
