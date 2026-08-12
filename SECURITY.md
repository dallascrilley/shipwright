# Security policy

## Reporting a vulnerability

Please do not open a public issue.

Use GitHub's private vulnerability reporting on this repository
(**Security** tab, **Report a vulnerability**), or email
`dallas@dallascrilley.com`.

Include what you did, what happened, and what you expected. A proof of concept
helps. I will acknowledge within 7 days and tell you whether I can reproduce it.

## Scope

Shipwright runs an untrusted coding agent against source code and then makes
authenticated GitHub writes, so the interesting reports are about that boundary:

- Anything that gets a credential, a host environment value, or host filesystem
  access into the sandbox session.
- Anything that gets a repository outside `GITHUB_REPOSITORY_ALLOWLIST` written
  to, or that widens what an App installation can reach.
- Anything that publishes without a passing verification run, or without the
  explicit `--publish` flag or console confirmation.
- Anything that defeats the patch policy in `src/pipeline/policy.ts`, especially
  writes to `.git/**` or `.github/workflows/**`.
- Anything that puts credential material into a receipt, a log line, an error
  message, or a webhook response.
- Prompt injection through issue text, review comments, or webhook payloads that
  escalates beyond the sandbox into a host action.

Out of scope: the security of the models Shipwright calls, vulnerabilities in
upstream dependencies without a Shipwright-specific exploit path, and findings
that require an operator to already have the GitHub App private key.

## Operator guidance

- Grant the GitHub App only metadata read, issues read, contents write, and pull
  requests write. Never Actions, Workflows, Administration, or Secrets.
- Keep `GITHUB_REPOSITORY_ALLOWLIST` as narrow as the work allows. A bare `*` is
  rejected by design, but `owner/*` is still broad.
- Keep the App private key and any OAuth session file outside the repository,
  owner-readable only.
- Receipts under `SHIPWRIGHT_STATE_DIR` are written at mode 0600 and redacted,
  but they still record repository and branch names. Treat that directory as
  sensitive.
- Always-on webhook automations default to publish-off. Do not raise a stage
  without walking `docs/runbooks/publish-stage-criteria.md`.

## Supported versions

This project has no tagged releases yet. Security fixes land on `main`.
