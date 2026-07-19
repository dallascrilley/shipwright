# Credentials

## GitHub App: rivet-test programming agent

- GitHub App: `rivet-test-agent-dallascrilley` (App ID `4337906`)
- Installation: `147573445`, restricted to `dallascrilley/rivet-test`
- Repository permissions: metadata read, issues read, contents read/write, and pull requests read/write. Webhooks are disabled.
- Private key: stored in 1Password's `Private` vault as item `lfvycashnv2qmghnhygiwfo574` (`GitHub App — rivet-test programming agent`). The item is the authoritative secret store; never commit or print its credential value.
- Local development key path: `/Users/dallascrilley/.config/rivet-test/rivet-test-agent.pem` (owner-readable only). Set `GITHUB_APP_PRIVATE_KEY_PATH` to this path alongside `GITHUB_APP_ID=4337906`, `GITHUB_APP_INSTALLATION_ID=147573445`, and `GITHUB_REPOSITORY_ALLOWLIST=dallascrilley/rivet-test`.
