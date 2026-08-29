# Shipwright Deployment

Shipwright's supported deployment target is Ubuntu 24.04 Noble on amd64
(x86_64). The rootless bootstrap rejects other distributions, Ubuntu releases,
and architectures before configuring Docker's rootless-extras repository. Use
rootful Docker only on a dedicated VM. On a shared host, use rootless Docker
under the `shipwright` account so the sandbox runner cannot control the host
daemon or another user's containers. The application binds to loopback, and
Agent Native authentication remains enabled in production. Access is either
Tailscale-only or a webhook-only HTTPS edge fronted by Caddy.

## Dedicated-host target and cost

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
| `/run/user/<shipwright-uid>/docker.sock` | Rootless Docker socket in shared-host mode |

`SHIPWRIGHT_DOCKER_MODE=rootful` adds the `shipwright` account to the Docker
group. Docker group membership is root-equivalent, so no unrelated workloads
belong on that host. `SHIPWRIGHT_DOCKER_MODE=rootless` creates a user Docker
service and does not grant Docker group membership. The Shipwright systemd unit
maps only the `shipwright` user's socket to `/var/run/docker.sock` inside the
service mount namespace because the pinned sandbox provider uses that path.

## Agent queue status

The control plane adds a durable store and a rollout-gated worker.
Which sources the deployed service executes is controlled by
`SHIPWRIGHT_ROLLOUT_STAGE` in `/etc/shipwright/shipwright.env`:

| Stage | Behavior |
| --- | --- |
| `disabled` (default) | No scheduler, no queue worker. UI actions still enqueue test runs but nothing claims them. |
| `test_only` | Worker claims operator-queued test runs only; the scheduler stays off and publication is forced off. |
| `dry_run` | Scheduler and GitHub triggers enqueue; every run is forced `publish: false`. |
| `approval_required` | Same as `dry_run`; publication requires the operator confirmation already built into the pipeline. Publication remains forced off at the queue boundary. |
| `publish_allowed` | Publication permitted only for agents whose pinned revision is `publish_allowed`. |

Advance one stage at a time and verify each before moving on. For the dry-run-first always-on checklist, see [docs/runbooks/always-on-activation.md](runbooks/always-on-activation.md). Before any `publish_allowed` stage or agent policy, complete [docs/runbooks/publish-stage-criteria.md](runbooks/publish-stage-criteria.md). The deploy script
refuses unknown stage values, and `bun run doctor` is run as the service user
on every deploy.

GitHub webhook processing stays inactive until the operator configures a
callback; `GITHUB_WEBHOOK_SECRET` lives only in the host environment.

Configure the GitHub App webhook with:

- URL: `https://<SHIPWRIGHT_PUBLIC_HOST>/api/github/webhook`
- Content type: `application/json`
- Secret: the same value stored as `GITHUB_WEBHOOK_SECRET`
- Events: Issues, Pull requests, and Pull request reviews

Pull-request review triggers additionally require `GITHUB_REVIEW_BOT_LOGIN`, the
exact login of the reviewing App's bot user (for example `my-reviewer[bot]`).
Review deliveries are rejected while it is unset, so no bot reviewer is trusted
by default. Set `GITHUB_REVIEW_BOT_USER_ID` to also pin the reviewer's numeric
user id, and `GITHUB_APP_INSTALLATION_ID` to require review deliveries to arrive
on exactly that installation. The webhook payload identifies a reviewer as a bot
user rather than by App id, which is why identity is pinned on login and user id.

`POST /api/github/webhook` is intentionally outside session authentication
because GitHub cannot hold a Shipwright session. The route authenticates every
delivery with `X-Hub-Signature-256` before parsing JSON, requires bounded
`X-GitHub-Event` and `X-GitHub-Delivery` values, rejects bodies larger than
1 MiB, and stores only the existing redacted trigger and queue records. A
valid delivery returns `202`; invalid signatures return `401`; invalid payloads
return `400`; unavailable host configuration or durable state returns `503`.
Keep the endpoint behind the existing HTTPS edge and never place the webhook
secret in a URL, repository file, fixture, receipt, or command history.

To hand off the PR feedback loop to a private Symphony receiver, optionally set
`SHIPWRIGHT_SYMPHONY_WEBHOOK_URL` in the host environment. The value must be a
credential-free `http` or `https` URL whose path is exactly
`/webhooks/github` and whose host is loopback, private-address space, or a
Tailscale `.ts.net` name. When configured, signed `pull_request` and
`check_suite` deliveries are forwarded byte-for-byte with the original GitHub
event, delivery, and signature headers. Pull-request deliveries still pass
through Shipwright's local intake; check-suite deliveries are relay-only.
Only Symphony's `202` response is an accepted private-ingress receipt. Timeouts
and every other response return `503` with `Retry-After: 10`, so GitHub can
redeliver. The relay is disabled when the variable is unset, and it is not added
to the public Caddy route.

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

Use an Ubuntu 24.04 x86 host. Public HTTP and HTTPS ports are not required for
private-only operation. The cloud firewall may have no public SSH rule, so
`ssh root@PUBLIC_IP` can time out by design. Use Tailscale SSH for bootstrap and
break-glass access.

Before the first shared-host deploy, set this host-local value:

```dotenv
SHIPWRIGHT_DOCKER_MODE=rootless
```

The bootstrap needs no manual Docker preparation: it installs the engine and
CLI from Ubuntu's `docker.io`, configures Docker's apt repository for
`docker-ce-rootless-extras` (the only publisher of
`dockerd-rootless-setuptool.sh`), and disables the system daemon it just
installed. A system Docker daemon that was already running for other tenants
is left untouched; Shipwright never depends on it in rootless mode.

The default is `rootful`. The deploy command reads the mode from
`/etc/shipwright/shipwright.env`, bootstraps the matching Docker service, and
then uploads the release:

```sh
deploy/deploy.sh root@TAILSCALE_HOSTNAME_OR_IP
```

The command refuses a dirty checkout, uploads the exact current commit, installs
locked dependencies, and pulls the sandbox image by immutable SHA-256 digest.
It provisions Bun 1.3.14, validates the configuration as the service user,
builds on Linux, switches the `current` symlink, and waits for loopback health.
If startup or health verification fails, it restores the previous release and
both systemd units. In rootless mode, the bootstrap enables the user's Docker
service and lingering so the daemon returns after a reboot, a system
supervisor unit watches the daemon's socket, and Shipwright is bound to that
supervisor with `BindsTo=` so a dead daemon stops the application instead of
leaving it attached to a dead socket. Switching back to rootful disables the
per-user Docker unit and lingering so no second daemon survives the switch.

The provisioned Linux Bun binary is mounted read-only at `/usr/local/bin/bun` in each disposable sandbox. `SandboxWorkspace.initialize()` requires the exact Mise-pinned version before cloning a repository or starting a model, so a missing or stale runtime fails as `sandbox Bun preflight` instead of consuming provider capacity and later returning `sh: 1: bun: not found`. Run `bun run provision:sandbox-bun` to repair a local cache; `bun run test:docker` provisions it automatically before the Docker lifecycle tests.

## Configure secrets

Before the first deploy, create `/etc/shipwright/shipwright.env` from `deploy/shipwright.env.example` and write the GitHub App key to `/etc/shipwright/github-app.pem`. Retrieve values from the existing 1Password items without printing them. Both files must be owned by `root:shipwright` with mode `0640`; `/etc/shipwright` is `root:shipwright` with mode `0750`, so the service can read but cannot rewrite its own credentials.

For the optional OpenAI Codex fallback, copy the signed-in operator's local `~/.codex/auth.json` to `/var/lib/shipwright/codex-auth.json`. The production copy must be owned by `shipwright:shipwright` with mode `0600`; Shipwright deliberately rejects group/world-readable files and files owned by another user. Configure `AGENTOS_CODEX_AUTH_FILE=/var/lib/shipwright/codex-auth.json`, `AGENTOS_FALLBACK_PROVIDER=openai-codex`, and `AGENTOS_FALLBACK_MODEL=gpt-5.4`. Replace this copy when the local Codex OAuth session rotates or the fallback reports an authentication failure. The deployment installs the lockfile-pinned Pi CLI; Shipwright mounts that dependency tree read-only and projects only the required OAuth fields into temporary storage inside the existing disposable agent sandbox. It does not install Pi extensions or packages at runtime.

The repository policy should remain owner-bound:

```dotenv
GITHUB_REPOSITORY_ALLOWLIST=dallascrilley/*,DallasCrilleyMarTech/*
```

This allowlist is only a Shipwright guardrail. The configured GitHub App must also be installed on both owners with access to the intended repositories. Leave `GITHUB_APP_INSTALLATION_ID` empty when the selector should enumerate repositories across every installation of that App; each run still resolves and verifies its repository installation before work starts.

Production must set a random `BETTER_AUTH_SECRET` of at least 32 characters. Do not set `AUTH_DISABLED`. Better Auth protects the operator console; the GitHub webhook uses its independent signature check. In Tailscale-only mode the tailnet is an additional network boundary. Authentication is never a function of the network path.

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

## Public GitHub webhook ingress (optional)

This path gives GitHub a public HTTPS endpoint without exposing the operator
console. Operators still administer the host through Tailscale SSH. The service
binds only to loopback; Caddy is the sole public listener and terminates TLS.

Weigh the tradeoff before enabling it. In rootful mode, the sandbox runner holds
root-equivalent Docker authority. In rootless mode, it controls only containers
and files owned by the `shipwright` account. The public edge forwards only
`POST /api/github/webhook`; every other request receives `404`. The application
verifies the GitHub signature before it parses or enqueues the payload.

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
enables Caddy. Caddy proxies only `POST /api/github/webhook`. The console and
the observability endpoints remain on loopback; Caddy does not expose them.

Verify from off-tailnet:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://shipwright.example.com/healthz
# expect 404
curl -sS -o /dev/null -w '%{http_code}\n' https://shipwright.example.com/api/github/webhook
# expect 404 because GET is not allowed
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST https://shipwright.example.com/api/github/webhook
# expect 401 because the request has no GitHub signature
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
sudo systemctl is-active shipwright-docker  # rootless mode only
sudo systemctl --user --machine=shipwright@ is-active docker.service
sudo -u shipwright env DOCKER_HOST=unix:///run/user/$(id -u shipwright)/docker.sock \
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
