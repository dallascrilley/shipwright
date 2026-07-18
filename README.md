# Programming agent example

This project includes the original agentOS Pi round-trip starter plus a guarded example that takes a GitHub issue, edits and tests its repository in an isolated Docker sandbox, and optionally opens a pull request.

The host owns GitHub authentication and publication. Pi receives a writable `/workspace` mount and sandbox shell tools, but never the GitHub App private key or installation token. The CLI is dry-run by default.

## Install

Prerequisites: Bun, Docker, one supported model API key, and a GitHub App installed only on selected repositories.

```sh
bun install
cp .env.example .env
```

The GitHub App needs repository metadata read, issues read, contents write, and pull requests write. It does not need Actions, workflows, administration, secrets, or organization permissions. Configure exact `owner/repo` entries in `GITHUB_REPOSITORY_ALLOWLIST`; wildcards are rejected.

Set `GITHUB_APP_ID`, exactly one of `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`, and optionally `GITHUB_APP_INSTALLATION_ID`. Configure one model key (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`) and use `AGENTOS_PROVIDER` when more than one is present. `AGENTOS_MODEL` overrides that provider's default model when account policy or availability requires it.

## Run the programming agent

Dry run (no branch, commit, push, or PR):

```sh
bun run programming-agent -- https://github.com/OWNER/REPO/issues/123 --verify "bun test"
```

Publish after independent verification and policy checks pass:

```sh
bun run programming-agent -- https://github.com/OWNER/REPO/issues/123 --verify "bun test" --publish
```

`--timeout-minutes` accepts 1 through 120 and defaults to 30. Each run uses a unique `agent/issue-<number>-<run-id>` branch. The host blocks empty changes, more than 100 files, patches over 1 MiB, `.git/**`, and `.github/workflows/**`. It never force-pushes.

Receipts are written atomically to `.artifacts/programming-agent/<run-id>/receipt.json`. A receipt records the issue, base SHA, generated branch, changed files, observed verification exit status, commit SHA, PR URL, and failure phase/code. If a push succeeds but PR creation fails, retain the receipt and generated branch for reconciliation; do not rerun blindly or delete the branch.

This is a single-run example, not a webhook service, durable queue, autonomous merger, or deployment system.

## Original round-trip starter

Start the server and client in separate terminals:

```sh
bun run server
bun run client
```

The client creates a VM, starts Pi, requires the response marker `AGENTOS_ROUND_TRIP_OK`, and closes the session.

## Tests

```sh
bun test
bun run typecheck
```

Deterministic tests do not require GitHub, Docker, or a model. `bun run test:e2e` runs the original real Pi round trip when a model key is present. Docker and live GitHub acceptance tests are opt-in and must target a disposable allowlisted repository owned by `dallascrilley` or `dallascrilleymartech`; they never merge a PR.

See the [agentOS documentation](https://agentos-sdk.dev/docs/) for sessions, software, permissions, persistence, and deployment.
