# Shipwright

**An agent that turns approved GitHub issues into tested, reviewable pull requests.**

[![CI](https://github.com/dallascrilley/shipwright/actions/workflows/ci.yml/badge.svg)](https://github.com/dallascrilley/shipwright/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6.svg)](tsconfig.json)
[![Bun](https://img.shields.io/badge/Bun-1.3.14-f9f1e1.svg)](mise.toml)

I built Shipwright because I wanted to know whether a coding agent had actually
fixed something before I looked at its diff. So the agent does not get to say.
It works in a disposable Docker sandbox, my host runs the repository's own
verification command against the result, and the pull request only exists if
that command exited zero and a human said publish.

## One run, end to end

```sh
bun run shipwright -- https://github.com/OWNER/REPO/issues/123 \
  --verify "bun test" --publish
```

```
intake     resolve issue 123, check OWNER/REPO against the allowlist, pin base SHA
workspace  start a disposable Docker sandbox, clone at the pinned SHA
agent      run Pi in the sandbox with the model key and nothing else
verify     run `bun test` in the sandbox, capture exit code and output tails
policy     reject empty diffs, >100 files, >1 MiB, .git/**, .github/workflows/**
publish    host pushes agent/issue-123-<run-id> and opens the PR
complete   write a mode-0600 receipt
```

The CLI prints the receipt it wrote. This is the `RunReceipt` shape from
[`src/pipeline/receipt.ts`](src/pipeline/receipt.ts), with values filled in to
show a passing run:

```json
{
  "runId": "9f2c1ab47de05310",
  "phase": "complete",
  "issueUrl": "https://github.com/OWNER/REPO/issues/123",
  "execution": {
    "runtime": "agentos",
    "software": "pi",
    "provider": "anthropic",
    "model": "claude-opus-4-6",
    "attempts": [{ "provider": "anthropic", "model": "claude-opus-4-6", "outcome": "succeeded" }]
  },
  "baseSha": "4c1e0a9f2b7d8e6a5304ff1b9c2d7e8a0b3f4c15",
  "branch": "agent/issue-123-9f2c1ab47de05310",
  "changedFiles": ["src/parser.ts", "test/parser.test.ts"],
  "verification": {
    "command": "bun test",
    "exitCode": 0,
    "passed": true,
    "stdoutTail": " 42 pass\n 0 fail\n"
  },
  "commitSha": "b81d5f0c3a2e4917d6c8b0a5f3e2149d7c60ab88",
  "pullRequestUrl": "https://github.com/OWNER/REPO/pull/456"
}
```

Drop `--publish` and the run stops after `policy`. No branch, no commit, no
push, no pull request, and a receipt that says exactly how far it got.

## The decision this project is built around

**The coding agent never holds a GitHub credential.**

Every agent-writes-PRs tool I looked at hands the model a token and hopes the
prompt holds. Shipwright splits the trust boundary at the sandbox wall instead.
[`src/agent/runner.ts`](src/agent/runner.ts) builds the sandbox session's
environment explicitly: `HOME`, `PI_CODING_AGENT_DIR`, and the model provider's
own key. The GitHub App private key, the installation token, and the host
environment stay on the host, and every git and GitHub write is executed by host
code in [`src/github/publisher.ts`](src/github/publisher.ts).

That is a claim, so it has a test.
[`test/agent/runner.test.ts`](test/agent/runner.test.ts) puts a
`must-not-be-projected` marker in the host's OAuth credential and asserts it
never appears in the file the sandbox can read.

The rest of the guardrails follow from the same split:

| Guardrail | Enforced in | Held to |
| --- | --- | --- |
| Repository allowlist, owner-bound, bare `*` rejected | `src/config/github.ts` | `test/deploy/github-owner-scope.test.ts` |
| Patch limits: 100 files, 1 MiB, no `.git/**`, no `.github/workflows/**` | `src/pipeline/policy.ts` | `test/pipeline/policy.test.ts` |
| Secret-shaped content in a patch blocks publication | `src/pipeline/secret-safety.ts` | `test/pipeline/policy.test.ts` |
| Tokens, JWTs, PEM blocks, and credential URLs redacted before a receipt is written | `src/pipeline/receipt.ts` | `test/pipeline/receipt.test.ts` |
| Failed verification performs no remote write at all | `src/pipeline/review-run.ts` | `test/pipeline/review-run.test.ts` |
| A head SHA that moved mid-run blocks commit, push, and thread writes | `src/pipeline/review-run.ts` | `test/pipeline/review-run.test.ts` |
| Fork pull-request heads are rejected before any work starts | `src/github/app-client.ts` | `test/github/app-client.test.ts` |

Shipwright never force-pushes. Each run gets a fresh
`agent/issue-<number>-<run-id>` branch.

## Quickstart

Deterministic verification needs Bun, Node, and pnpm. It does not need Docker, a
model key, or a GitHub App.

```sh
git clone https://github.com/dallascrilley/shipwright
cd shipwright
bun install --frozen-lockfile
(cd ui && pnpm install --frozen-lockfile)
bun run verify
```

`bun run verify` is the whole gate: host typecheck, host tests, console
typecheck, console tests, console build. It is the same set of commands
[CI](.github/workflows/ci.yml) runs on every pull request.

To see the operator console without any credentials at all:

```sh
SHIPWRIGHT_UI_DEMO=1 AUTH_DISABLED=true bun run dev
```

Demo mode is dry-run only. It exercises the console and the pipeline's shape on
localhost with no GitHub App, no model key, and no Docker.

For real runs, `bun run bootstrap` installs both lockfiles, creates a mode-0600
`.env`, pulls the digest-pinned sandbox image, and provisions the sandbox Bun.
It requires a running Docker daemon. Then fill in `.env` and check readiness:

```sh
bun run doctor
```

Credential setup, including the exact GitHub App permissions, is in
[docs/credentials.md](docs/credentials.md).

## What this does and does not do

**What is real and verifiable from this repository.** The pipeline, the
guardrails, the receipt format, the operator console, the deployment scripts,
and 372 passing tests across two suites (127 host, 245 console), all of which
run in CI on every pull request with no credentials. The security properties in
the table above are each held to a named test you can read and run.

**What is self-reported.** I have run the full issue-to-PR pipeline against my
own repositories, but that path needs a Docker daemon, a model API key, and a
GitHub App private key, so CI cannot prove it and neither can a cold clone. The
Docker, local-agent, and live acceptance tests exist
(`bun run test:docker`, `bun run test:local-pi`, `bun run test:live`) and skip
themselves unless you set their environment flags and supply credentials.

**What is illustrative.** The receipt above is a filled-in example of the real
`RunReceipt` schema, not a captured artifact. The field names and the phase
sequence are exactly what the code produces; the SHAs and URLs are made up.

**What this is not.** It is a single-operator service. There is no hosted
instance, no package on any registry, no multi-tenant story, and no autonomous
merge. Publication is a human decision every time: the CLI requires `--publish`
and the console requires a second confirmation.

**Known limits.** The agent's quality is the model's quality; Shipwright only
guarantees that a failing verification never becomes a pull request. Large or
cross-cutting issues hit the 100-file and 1 MiB limits by design. The always-on
webhook path defaults to publish-off and stays there until you walk the staged
criteria in [docs/runbooks/publish-stage-criteria.md](docs/runbooks/publish-stage-criteria.md).

## The rest of the system

**PR review CLI.** The same trust split applied to review feedback. It targets
one same-repository pull request head, projects an explicitly selected
`fix-review-findings` skill into the sandbox, treats every review comment as
untrusted data, verifies changes independently, and requires one explicit
outcome per unresolved thread. Threads that are fixed, rejected, or concretely
deferred get an idempotent reply and are resolved. Threads marked `needs-human`
get a reply and stay open.

```sh
bun run review-agent -- https://github.com/OWNER/REPO/pull/123 \
  --verify "bun test" \
  --skill /absolute/path/to/fix-review-findings/SKILL.md
```

**Operator console.** An Agent Native app under [`ui/`](ui/). Credentials stay
server-side, runs default to dry-run, phase and receipt evidence stream live,
and publication needs a second confirmation. Run records persist atomically, so
completed history survives a restart and an unfinished run is marked interrupted
rather than silently resumed. See [ui/DEVELOPING.md](ui/DEVELOPING.md).

**Always-on automations.** Signed GitHub webhooks can enqueue runs for
allowlisted repositories, narrowed by event actor, labels, base branch, and
draft state. Conditions within one trigger are ANDed; separate triggers are
alternatives and still queue at most one execution per delivery. Missing or
malformed event data fails closed. Conditions never grant publish authority.
See [docs/runbooks/always-on-activation.md](docs/runbooks/always-on-activation.md).

**Deployment.** A systemd service on a dedicated Linux VM, reachable privately
over Tailscale, with an optional public HTTPS edge. The service builds on the
Linux host so native dependencies match the target architecture. See
[docs/deployment.md](docs/deployment.md).

## Repository layout

```
src/          host pipeline: intake, sandbox, agent, verify, policy, publish
test/         host test suite (bun test)
ui/           Agent Native operator console (pnpm, Vite, React Router, vitest)
deploy/       systemd unit, Caddyfile, host bootstrap and deploy scripts
docs/         credentials, deployment, operator runbooks, engineering notes
scripts/      bootstrap, doctor, sandbox provisioning, webhook replay
```

Two dependency trees on purpose: the host uses Bun with `bun.lock`, the console
uses pnpm with `ui/pnpm-lock.yaml`. Run every root script from the repository
root; `dev`, `build`, `start`, and `verify` change into `ui/` themselves.

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md) covers the local loop and what a change needs
before review. [SECURITY.md](SECURITY.md) covers reporting a vulnerability.
Please do not open a public issue for a security problem.

Built on [AgentOS](https://agentos-sdk.dev/docs/) for sandbox sessions and Pi
for the coding agent.

## License

MIT. See [LICENSE](LICENSE).
