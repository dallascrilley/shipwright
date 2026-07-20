# Credentials

## GitHub App: Shipwright

- GitHub App: `rivet-test-agent-dallascrilley` (App ID `4337906`; retained as the existing external app slug)
- Installation: `147573445`, restricted to `dallascrilley/shipwright`
- Repository permissions: metadata read, issues read, contents read/write, and pull requests read/write. Webhooks are disabled.
- Private key: stored in 1Password's `Private` vault as item `lfvycashnv2qmghnhygiwfo574` (`GitHub App — rivet-test programming agent`). The legacy item title is retained to avoid duplicating the authoritative secret; never commit or print its credential value.
- Local development key path: `/Users/dallascrilley/.config/shipwright/github-app.pem` (owner-readable only). Set `GITHUB_APP_PRIVATE_KEY_PATH` to this path alongside `GITHUB_APP_ID=4337906`, `GITHUB_APP_INSTALLATION_ID=147573445`, and `GITHUB_REPOSITORY_ALLOWLIST=dallascrilley/shipwright`.

## Kimi K3 coding model

- Provider: Kimi's coding endpoint (`https://api.kimi.com/coding/v1`) with model `k3`.
- 1Password: use `op://Private/Kimi for Coding API Credentials/credential` from item `63t77dfdpvb6xeckdsxjyosrwa`; it is the authoritative key store and must not be committed or printed.
- Local invocation: use `op run` to inject `KIMI_API_KEY`, set `AGENTOS_PROVIDER=kimi`, and set `AGENTOS_MODEL=k3`. The agent writes the compatible Pi model catalog inside its sandbox at runtime.
