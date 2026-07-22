# Shipwright

Turn GitHub issues into verified pull requests.

Shipwright authorizes an allowlisted GitHub issue, gives Kimi or another supported model an isolated Docker workspace through AgentOS and Pi, independently runs the repository's verification command, and publishes only after explicit operator confirmation. GitHub credentials stay on the host and are never passed to the coding agent.

The project includes a CLI and a private Agent Native operator console. It is intentionally a single-operator service, not an autonomous merger or public multi-tenant SaaS.

## Bootstrap

Prerequisites are Docker and either [mise](https://mise.jdx.dev/) or the Bun, Node, and pnpm versions pinned in `mise.toml`.

```sh
bun run bootstrap
```

Bootstrap installs both lockfiles and creates a mode-0600 `.env` from `.env.example` when needed. Configure one model key plus the least-privileged GitHub App values, then run:

```sh
bun run doctor
bun run dev
```

The GitHub App needs repository metadata read, issues read, contents write, and pull requests write. It does not need Actions, workflows, administration, secrets, or organization permissions. `GITHUB_REPOSITORY_ALLOWLIST` accepts comma-separated exact `owner/repo` entries and owner-bound `owner/*` scopes; bare wildcards are rejected. The checked-in examples permit `dallascrilley/*` and `DallasCrilleyMarTech/*`, but the App must still be installed with access to each repository—Shipwright never widens GitHub installation access.

## Issue-to-PR CLI

Dry run (no branch, commit, push, or pull request):

```sh
bun run shipwright -- https://github.com/OWNER/REPO/issues/123 --verify "bun test"
```

Publish only after independent verification and policy checks pass:

```sh
bun run shipwright -- https://github.com/OWNER/REPO/issues/123 --verify "bun test" --publish
```

`--timeout-minutes` accepts 1 through 120 and defaults to 30. Each run uses a unique `agent/issue-<number>-<run-id>` branch. Shipwright blocks empty changes, more than 100 files, patches over 1 MiB, `.git/**`, and `.github/workflows/**`. It never force-pushes.

Receipts are written atomically under `${SHIPWRIGHT_STATE_DIR:-.artifacts/shipwright}/receipts/<run-id>/receipt.json`. They record non-secret execution provenance, issue and base identity, changed files, verification result, commit SHA, pull-request URL, and failure phase. If a push succeeds but pull-request creation fails, retain the receipt and generated branch for reconciliation; do not rerun blindly.

## PR review CLI

The separate review workflow targets an existing same-repository pull request head. It projects an explicitly selected `fix-review-findings` Agent Skill into Pi, treats review text as untrusted, independently verifies warranted changes, and keeps GitHub credentials plus thread mutations on the trusted host.

Dry run:

```sh
bun run review-agent -- https://github.com/OWNER/REPO/pull/123 \
  --verify "bun test" \
  --skill /absolute/path/to/fix-review-findings/SKILL.md
```

Publish verified changes and reply to the original threads:

```sh
bun run review-agent -- https://github.com/OWNER/REPO/pull/123 \
  --verify "bun test" \
  --skill /absolute/path/to/fix-review-findings/SKILL.md \
  --publish
```

The host pins the authorized PR head SHA, rejects fork heads and moved branches, and requires one explicit outcome per unresolved current thread. Fixed, rejected, and concretely deferred threads receive an idempotent reply and are resolved; `needs-human` threads receive a reply and remain open. Review receipts are written with mode 0600 under `${SHIPWRIGHT_STATE_DIR:-.artifacts/shipwright}/review-receipts/<run-id>/receipt.json` and record the canonical skill's SHA-256 digest, never its contents or host path.

## Operator console

The console keeps credentials server-side, defaults to dry-run, shows live phase and receipt evidence, and requires a second confirmation before publication. Run it from the repository root with `bun run dev`, then open the printed local URL.

For a credential-free deterministic UI smoke:

```sh
SHIPWRIGHT_UI_DEMO=1 bun run dev
```

Run records persist atomically under `SHIPWRIGHT_STATE_DIR`. Completed history survives restarts; an unfinished run is marked interrupted rather than silently resumed.

Agent automations can target any GitHub App-accessible repository allowed by
`GITHUB_REPOSITORY_ALLOWLIST`, select one of the curated issue or pull-request
events, and provide agent instructions. An optional condition editor narrows
GitHub triggers by event actor, labels, pull-request base branch, and
pull-request draft state. Conditions within one trigger use AND; separate
triggers for the same agent revision are OR alternatives and still queue at
most one execution per GitHub delivery. Missing or malformed event data fails
closed. **Copy as JSON** emits the version-2 condition contract; version-1
documents remain readable, but JSON import is not supported.

GitHub webhook executions retain the agent revision's publication policy;
conditions never grant publish authority. Accepted webhook responses contain
only bounded match counts, trigger IDs, and reason codes—not raw payloads or
delivered condition values.

## Verification

```sh
bun run verify
```

Deterministic checks do not require GitHub, Docker, or a model. Docker and live acceptance tests are opt-in:

```sh
bun run test:docker
bun run test:local-pi
bun run test:live
```

Live tests must target an explicitly configured disposable issue in an allowlisted repository owned by `dallascrilley` or `dallascrilleymartech`.

## Deployment

Production runs as a systemd service on a dedicated Linux VM and is exposed privately through Tailscale. The service builds on the Linux host so native Agent Native dependencies match the target architecture. See [docs/deployment.md](docs/deployment.md).

See the [AgentOS documentation](https://agentos-sdk.dev/docs/) for sessions, software, permissions, and sandbox behavior.
