# Shipwright Deployment

Shipwright runs on a dedicated Ubuntu 24.04 x86 VM. It is not placed on a shared Docker host because its sandbox runner has Docker daemon authority. The application binds to loopback and Agent Native authentication remains enabled in production. Access is either Tailscale-only (default) or a public HTTPS edge fronted by Caddy; in both cases the service itself is never bound to a public interface.

## Target and cost

- Provider: Hetzner Cloud
- Location: Helsinki (`hel1`)
- Class: CX33 or equivalent x86 shared instance
- Operating ceiling: about USD $11/month before tax, including IPv4, with no backups or add-on volumes
- Review: reassess size and retention after 30 days
- Teardown: export `/var/lib/shipwright`, remove the Tailscale node and any public DNS record, then delete the server and firewall

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

The U6 rollout adds a durable control-plane store and a rollout-gated worker.
Which sources the deployed service executes is controlled by
`SHIPWRIGHT_ROLLOUT_STAGE` in `/etc/shipwright/shipwright.env`:

| Stage | Behavior |
| --- | --- |
| `disabled` (default) | No scheduler, no queue worker. UI actions still enqueue test runs but nothing claims them. |
| `test_only` | Worker claims operator-queued test runs only; the scheduler stays off and publication is forced off. |
| `dry_run` | Scheduler and GitHub triggers enqueue; every run is forced `publish: false`. |
| `approval_required` | Same as `dry_run`; publication requires the operator confirmation already built into the pipeline. Publication remains forced off at the queue boundary. |
| `publish_allowed` | Publication permitted only for agents whose pinned revision is `publish_allowed`. |

Advance one stage at a time and verify each before moving on. The deploy script
refuses unknown stage values, and `bun run doctor` is run as the service user
on every deploy.

GitHub webhook processing stays inactive until the operator configures a
callback; `GITHUB_WEBHOOK_SECRET` lives only in the host environment.

Configure the GitHub App webhook with:

- URL: `https://<SHIPWRIGHT_PUBLIC_HOST>/api/github/webhook`
- Content type: `application/json`
- Secret: the same value stored as `GITHUB_WEBHOOK_SECRET`
- Events: Issues and Pull requests

`POST /api/github/webhook` is intentionally outside session authentication
because GitHub cannot hold a Shipwright session. The route authenticates every
delivery with `X-Hub-Signature-256` before parsing JSON, requires bounded
`X-GitHub-Event` and `X-GitHub-Delivery` values, rejects bodies larger than
1 MiB, and stores only the existing redacted trigger and queue records. A
valid delivery returns `202`; invalid signatures return `401`; invalid payloads
return `400`; unavailable host configuration or durable state returns `503`.
Keep the endpoint behind the existing HTTPS edge and never place the webhook
secret in a URL, repository file, fixture, receipt, or command history.

## Observability

The service exposes three unauthenticated loopback endpoints (added to the
auth guard `publicPaths` because systemd and tailnet scrapers have no
session):

- `GET /healthz` — liveness; process is up.
- `GET /readyz` — readiness; durable control-plane state loads and an active
  scheduler is not overdue. Returns 503 with redacted reasons on failure.
- `GET /metrics` — Prometheus text exposition of aggregate state only: queue
  depth by state, oldest active lease age, lifecycle events by action,
  terminal entries, paused circuit breakers, and the configured rollout
  stage. It never emits agent ids, repository names, target URLs, run ids,
  instructions, or any operator-supplied text.

The deploy health gate requires both `/healthz` and `/readyz` to return 200
before the new release is kept.

Recommended alert rules (point your scraper/alerting at the tailnet address):

- `shipwright_oldest_active_lease_age_seconds > 300` for 10 minutes — stale lease.
- `shipwright_queue_entries{state="dead_letter"} > 0` — dead letter needs triage.
- `increase(shipwright_queue_entries{state="queued"}[1h]) > 20` without matching terminal entries — unexpected queue growth.
- `shipwright_paused_circuit_breakers > 0` — a schedule circuit breaker opened.
- `/readyz` returning non-200 — scheduler failure or unreadable state.

Alerts must route only these aggregate series; never forward raw payloads,
prompt contents, or credentials.

## Backup and restore

The control-plane snapshot is one file,
`$SHIPWRIGHT_STATE_DIR/agent-control-plane.json`, written atomically with
mode 0600. Operator-run receipts remain independent and unaffected by
control-plane rollback.

```sh
deploy/control-plane-state.sh backup /var/lib/shipwright /var/lib/shipwright/backups
deploy/control-plane-state.sh restore /var/lib/shipwright/backups/agent-control-plane.json.<stamp> /var/lib/shipwright
```

Restore validates the JSON parses as a version-1 snapshot, writes mode `0600`,
and preserves the existing live snapshot's numeric owner and group before
atomically replacing it. If no live snapshot exists, restore uses the state
directory owner and group. An operator may set `SHIPWRIGHT_STATE_OWNER=<uid>:<gid>`
for a deliberate numeric override. A nightly cron `backup` run with 30-day
retention is sufficient; test restore quarterly and confirm `/readyz` remains
HTTP 200 after the service restarts.

## Provision

Create an Ubuntu 24.04 x86 server. Public HTTP/HTTPS ports are not required. The production host is intended to be Tailscale-only: the cloud firewall may intentionally have **no public SSH rule**, so `ssh root@PUBLIC_IP` can time out by design. Bootstrap and break-glass access use Tailscale SSH (or a temporary source-IP-restricted SSH rule).

The deploy command bootstraps Docker, mise, pinned runtimes, Tailscale, the service user, and persistent directories before uploading a release:

```sh
deploy/deploy.sh root@TAILSCALE_HOSTNAME_OR_IP
```

The command refuses a dirty checkout, uploads the exact current commit to a new release directory, installs locked dependencies, pulls the sandbox image by immutable SHA-256 digest, provisions Bun 1.3.14 from an immutable `oven/bun` image into the service user's tool cache, validates the full GitHub/model configuration as the service user, builds on the Linux host, atomically moves the `current` symlink, starts the service, and waits for a loopback HTTP response. If startup or health verification fails, it automatically restores the previous release and systemd unit.

The provisioned Linux Bun binary is mounted read-only at `/usr/local/bin/bun` in each disposable sandbox. `SandboxWorkspace.initialize()` requires the exact Mise-pinned version before cloning a repository or starting a model, so a missing or stale runtime fails as `sandbox Bun preflight` instead of consuming provider capacity and later returning `sh: 1: bun: not found`. Run `bun run provision:sandbox-bun` to repair a local cache; `bun run test:docker` provisions it automatically before the Docker lifecycle tests.

## Configure secrets

Before the first deploy, create `/etc/shipwright/shipwright.env` from `deploy/shipwright.env.example` and write the GitHub App key to `/etc/shipwright/github-app.pem`. Retrieve values from the existing 1Password items without printing them. Both files must be owned by `root:shipwright` with mode `0640`; `/etc/shipwright` is `root:shipwright` with mode `0750`, so the service can read but cannot rewrite its own credentials.

For the optional OpenAI Codex fallback, copy the signed-in operator's local `~/.codex/auth.json` to `/var/lib/shipwright/codex-auth.json`. The production copy must be owned by `shipwright:shipwright` with mode `0600`; Shipwright deliberately rejects group/world-readable files and files owned by another user. Configure `AGENTOS_CODEX_AUTH_FILE=/var/lib/shipwright/codex-auth.json`, `AGENTOS_FALLBACK_PROVIDER=openai-codex`, and `AGENTOS_FALLBACK_MODEL=gpt-5.4`. Replace this copy when the local Codex OAuth session rotates or the fallback reports an authentication failure. The deployment installs the lockfile-pinned Pi CLI; Shipwright mounts that dependency tree read-only and projects only the required OAuth fields into temporary storage inside the existing disposable agent sandbox. It does not install Pi extensions or packages at runtime.

The repository policy should remain owner-bound:

```dotenv
GITHUB_REPOSITORY_ALLOWLIST=dallascrilley/*,DallasCrilleyMarTech/*
```

This allowlist is only a Shipwright guardrail. The configured GitHub App must also be installed on both owners with access to the intended repositories. Leave `GITHUB_APP_INSTALLATION_ID` empty when the selector should enumerate repositories across every installation of that App; each run still resolves and verifies its repository installation before work starts.

Production must set a random `BETTER_AUTH_SECRET` of at least 32 characters. Do not set `AUTH_DISABLED`. In Tailscale-only mode the tailnet is an additional network boundary; in public HTTPS mode Better Auth is the *sole* access control, so the secret strength and account hygiene matter even more. Authentication is never a function of the network path.

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

## Public HTTPS access (optional)

This path removes the Tailscale requirement for operators: anyone with the URL
and a valid account can reach the console over public HTTPS. The service still
binds only to loopback — Caddy is the sole public listener and terminates TLS.

Weigh the tradeoff before enabling it. The sandbox runner holds Docker daemon
authority (root-equivalent on this host), so the public edge makes Better Auth
the only thing standing between the internet and that authority. Keep
`BETTER_AUTH_SECRET` strong and never set `AUTH_DISABLED`.

Operator steps:

1. **DNS** — create an `A` (and optional `AAAA`) record for your chosen name,
   e.g. `shipwright.example.com`, pointing at the VM's public IP. If you use a
   CDN, set the record to DNS-only (grey cloud) so Caddy can complete the
   Let's Encrypt challenge and see the real client.
2. **Firewall** — open inbound `80/tcp` and `443/tcp` on the Hetzner cloud
   firewall. Port 80 is required for the ACME HTTP challenge and the HTTPS
   redirect; 443 serves the app. SSH may stay closed (use Tailscale SSH).
3. **Config** — set `SHIPWRIGHT_PUBLIC_HOST` in `/etc/shipwright/shipwright.env`
   to the exact DNS name, then run `deploy/deploy.sh <ssh-target>`.
4. **Free port 443** — if the host was previously in Tailscale-only mode,
   `tailscale serve` is bound to `:443` and Caddy cannot start
   (`listen tcp :443: bind: address already in use`). Retire it with
   `tailscale serve reset` on the VM, then `systemctl restart caddy`.
   Tailscale SSH is unaffected and stays available for administration.

The deploy renders `deploy/Caddyfile` to `/etc/caddy/Caddyfile` with the name
substituted, validates it, opens host `ufw` 80/443 when `ufw` is active, and
enables Caddy. The unauthenticated observability endpoints (`/healthz`,
`/readyz`, `/metrics`) are answered `404` at the public edge and remain
reachable only over loopback/tailnet for scrapers.

Verify from off-tailnet:

```sh
curl -fsS https://shipwright.example.com/healthz   # expect 404 at the edge
curl -fsSI https://shipwright.example.com/          # expect 200 with a valid cert
```

On the host: `systemctl status caddy --no-pager` and
`journalctl -u caddy -n 50 --no-pager` show certificate issuance. First-cert
issuance can take a few seconds after DNS resolves.

To return to Tailscale-only, clear `SHIPWRIGHT_PUBLIC_HOST`, run
`systemctl disable --now caddy`, and close firewall 80/443.

## Verify

```sh
tailscale ssh shipwright@TAILSCALE_HOSTNAME_OR_IP
systemctl is-active shipwright
systemctl status shipwright --no-pager
curl -fsS http://127.0.0.1:4317/healthz
curl -fsS http://127.0.0.1:4317/readyz
curl -fsS http://127.0.0.1:4317/metrics | head -20
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
curl -fsS http://127.0.0.1:4317/healthz
curl -fsS http://127.0.0.1:4317/readyz
```

State and credentials remain outside release directories, so code rollback does not replace receipts, the database, or secrets.
