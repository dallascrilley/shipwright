# Credentials

## GitHub App: Shipwright

- GitHub App: `rivet-test-agent-dallascrilley` (App ID `4337906`; retained as the existing external app slug)
- Installation: `147573445`, restricted to `dallascrilley/shipwright`
- Repository permissions: metadata read, issues read, contents read/write, and pull requests read/write. Webhooks are disabled.
- Private key: stored in 1Password's `Private` vault as item `lfvycashnv2qmghnhygiwfo574` (`GitHub App — rivet-test programming agent`). The legacy item title is retained to avoid duplicating the authoritative secret; never commit or print its credential value.
- Production authentication secret: stored in 1Password's `Private` vault as item `3cdoazfvs6v6vvdlfhlg5a37oa` (`Shipwright Production`).
- Local development key path: `/Users/dallascrilley/.config/shipwright/github-app.pem` (owner-readable only). Set `GITHUB_APP_PRIVATE_KEY_PATH` to this path alongside `GITHUB_APP_ID=4337906`, `GITHUB_APP_INSTALLATION_ID=147573445`, and `GITHUB_REPOSITORY_ALLOWLIST=dallascrilley/shipwright`.

## Kimi K3 coding model

- Provider: Kimi's coding endpoint (`https://api.kimi.com/coding/v1`) with model `k3`.
- 1Password: use `op://Private/Kimi for Coding API Credentials/credential` from item `63t77dfdpvb6xeckdsxjyosrwa`; it is the authoritative key store and must not be committed or printed.
- Local invocation: use `op run` to inject `KIMI_API_KEY`, set `AGENTOS_PROVIDER=kimi`, and set `AGENTOS_MODEL=k3`. The agent writes the compatible Pi model catalog inside its sandbox at runtime.

## GitHub App: Shipwright DCM review agent

- Product name: Shipwright; GitHub registration: `shipwright-dcm` (App ID `4342351`). GitHub reserves the exact `Shipwright` registration name for `@shipwright`.
- Installation: `147693967`, restricted to `DallasCrilleyMarTech/.hub`.
- Repository permissions: metadata read, issues read, contents read/write, and pull requests read/write. OAuth, device flow, and webhooks are disabled.
- Private key: stored in 1Password's `Private` vault as item `qco4aporpanrmwxvnxcdtbpvhu` (`Shipwright DCM GitHub App`). The item is the authoritative secret store; never commit or print its credential value.
- Local invocation: read the App ID from `op://Private/Shipwright DCM GitHub App/username` and the private key from `op://Private/Shipwright DCM GitHub App/credential`; set `GITHUB_APP_INSTALLATION_ID=147693967` and `GITHUB_REPOSITORY_ALLOWLIST=DallasCrilleyMarTech/.hub`.

## Repository allowlist format

`GITHUB_REPOSITORY_ALLOWLIST` accepts a comma-separated mix of exact `owner/repo` entries and owner scopes written `owner/*`, which permit every repository under that owner (for example `dallascrilley/*, DallasCrilleyMarTech/*`). A bare `*` or `*/*` is rejected — scopes are always owner-bound. The GitHub App installation must also grant access to the repositories a scope is meant to cover; Shipwright's own guardrail never widens what the installation can reach.

The production target policy is `GITHUB_REPOSITORY_ALLOWLIST=dallascrilley/*,DallasCrilleyMarTech/*`. To populate both owners in the Agents repository selector, one configured GitHub App must be installed on both owners with the intended repository access. Leave `GITHUB_APP_INSTALLATION_ID` unset so repository discovery can enumerate every installation for that App; per-run authorization still resolves and verifies the target installation.
