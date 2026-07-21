# Shipwright Deployment

Shipwright runs on a dedicated Ubuntu 24.04 x86 VM. It is not placed on a shared Docker host because its sandbox runner has Docker daemon authority. The application binds to loopback, Tailscale provides the private HTTPS boundary, and Agent Native authentication remains enabled in production.

## Target and cost

- Provider: Hetzner Cloud
- Location: Helsinki (`hel1`)
- Class: CX33 or equivalent x86 shared instance
- Operating ceiling: about USD $11/month before tax, including IPv4, with no backups or add-on volumes
- Review: reassess size and retention after 30 days
- Teardown: export `/var/lib/shipwright`, remove the Tailscale node, then delete the server and firewall

## Host layout

| Path | Purpose |
| --- | --- |
| `/opt/shipwright/releases/<commit>` | Immutable deployed source and Linux-native build |
| `/opt/shipwright/current` | Atomic symlink to the active release |
| `/etc/shipwright/shipwright.env` | Root-owned, group-readable production environment |
| `/etc/shipwright/github-app.pem` | Root-owned, group-readable GitHub App private key |
| `/var/lib/shipwright` | Agent Native database, run registry, receipts, and service home |

The systemd service runs as the unprivileged `shipwright` account with Docker group membership. This membership is root-equivalent on the dedicated VM; no unrelated workloads belong on the host.

## Agent queue status

The Phase 2 queue dispatcher is a library and demo adapter only. The deployed systemd
service does not start queue workers or activate agent triggers. Do not add a worker
process until a durable transactional control-plane store and the U6 rollout are in
place; the current in-memory store is test-only.

## Provision

Create an Ubuntu 24.04 x86 server. Public HTTP/HTTPS ports are not required. The production host is intended to be Tailscale-only: the cloud firewall may intentionally have **no public SSH rule**, so `ssh root@PUBLIC_IP` can time out by design. Bootstrap and break-glass access use Tailscale SSH (or a temporary source-IP-restricted SSH rule).

The deploy command bootstraps Docker, mise, pinned runtimes, Tailscale, the service user, and persistent directories before uploading a release:

```sh
deploy/deploy.sh root@TAILSCALE_HOSTNAME_OR_IP
```

The command refuses a dirty checkout, uploads the exact current commit to a new release directory, installs locked dependencies, pulls the sandbox image by immutable SHA-256 digest, validates the full GitHub/model configuration as the service user, builds on the Linux host, atomically moves the `current` symlink, starts the service, and waits for a loopback HTTP response. If startup or health verification fails, it automatically restores the previous release and systemd unit.

## Configure secrets

Before the first deploy, create `/etc/shipwright/shipwright.env` from `deploy/shipwright.env.example` and write the GitHub App key to `/etc/shipwright/github-app.pem`. Retrieve values from the existing 1Password items without printing them. Both files must be owned by `root:shipwright` with mode `0640`; `/etc/shipwright` is `root:shipwright` with mode `0750`, so the service can read but cannot rewrite its own credentials.

Production must set a random `BETTER_AUTH_SECRET` of at least 32 characters. Do not set `AUTH_DISABLED`; Tailscale is an additional network boundary, not a substitute for application authentication.

## Private access

Primary operator access is Tailscale, not the public internet.

Join the VM to the authorized tailnet, enable Tailscale SSH, then publish only the loopback service:

```sh
tailscale up --ssh
tailscale serve --bg http://127.0.0.1:4317
tailscale serve status
```

Operate over the tailnet:

```sh
tailscale ssh shipwright@TAILSCALE_HOSTNAME_OR_IP
# or: ssh shipwright@100.x.y.z
```

Use the HTTPS URL reported by `tailscale serve status`. On first visit, create the single operator account through Agent Native's normal Better Auth flow.

Optional break-glass: temporarily allow SSH from a single trusted source IP on the cloud firewall, complete the repair, then remove the rule so public SSH stays closed.

## Verify

```sh
tailscale ssh shipwright@TAILSCALE_HOSTNAME_OR_IP
systemctl is-active shipwright
systemctl status shipwright --no-pager
curl -fsS http://127.0.0.1:4317/ >/dev/null
tailscale serve status
docker ps --format 'table {{.Names}}\t{{.Status}}'
df -h /
free -h
```

The deployed commit is the basename of the active release target:

```sh
basename "$(readlink -f /opt/shipwright/current)"
```

After infrastructure health passes, run a dry-run issue first. A publish proof must use an allowlisted repository, explicit verification command, and operator confirmation; record the resulting pull-request URL and exact head SHA.

## Roll back

List previous releases, choose a known-good commit, repoint the symlink, and restart the service:

```sh
ls -1 /opt/shipwright/releases
ln -sfn /opt/shipwright/releases/KNOWN_GOOD_COMMIT /opt/shipwright/current.next
mv -Tf /opt/shipwright/current.next /opt/shipwright/current
systemctl restart shipwright
curl -fsS http://127.0.0.1:4317/ >/dev/null
```

State and credentials remain outside release directories, so code rollback does not replace receipts, the database, or secrets.
