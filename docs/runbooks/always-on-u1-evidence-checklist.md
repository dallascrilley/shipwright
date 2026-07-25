---
date: 2026-07-25
topic: always-on-u1-evidence
origin: docs/runbooks/always-on-activation.md
td: td-fae961
---

# U1 evidence checklist (td-fae961)

Copy this into `td log td-fae961 --note "..."` as you complete each section on the **remote pin**. Do not paste secrets.

## A. Baseline (`disabled`)

| Field | Value |
| --- | --- |
| Pin host (Tailscale name or role) | |
| Deploy revision (`git rev-parse HEAD` on pin) | |
| `SHIPWRIGHT_ROLLOUT_STAGE` | `disabled` |
| `/healthz` | pass / fail |
| `/readyz` | pass / fail |
| Timestamp (UTC) | |

## B. Webhook wiring

| Field | Value |
| --- | --- |
| `SHIPWRIGHT_PUBLIC_HOST` (no path) | |
| GitHub App ID | |
| Installation covers repo used in proof | |
| Webhook events subscribed | Issues + Pull requests |
| Invalid signature → 401 (GitHub delivery or local replay) | yes / no |
| Secret stored only in env + GitHub (not in git/td) | confirmed |

Local signature check before going public:

```sh
export GITHUB_WEBHOOK_SECRET='…'   # from 1Password / host env
./scripts/replay-github-webhook.sh -u "http://127.0.0.1:PORT/api/github/webhook"
```

Use wrong secret once → expect rejection (401/403 per deployment).

## C. `test_only` proof

| Field | Value |
| --- | --- |
| Stage set + restart time (UTC) | |
| Agent id (disabled → test run) | |
| Test run execution id | |
| Receipt shows dry-run / no publish | yes / no |
| Live GitHub delivery did **not** enqueue trigger work | yes / no |

## D. Dry-run agent configured (still `test_only` until step E)

| Field | Value |
| --- | --- |
| Agent id + current revision | |
| Repository (`owner/repo`) | |
| `actionPreset` | `fix_issue` or `resolve_pr_feedback` |
| Publication policy on revision | `dry_run` |
| Curated trigger (event + action) | |
| Agent **enabled** after successful test | yes / no |

## E. `dry_run` stage + signed delivery (R2)

| Field | Value |
| --- | --- |
| Stage advanced to `dry_run` + restart (UTC) | |
| `X-GitHub-Delivery` id | |
| First POST HTTP status | |
| Execution / queue id from Operator history | |
| `idempotencyKey` shape | `github:<delivery>:<revision>` |
| Replay same delivery → second HTTP 202, **no second execution** | yes / no |
| Receipt: dry-run, no push / no PR thread mutation | yes / no |

Replay helper (loopback or public URL):

```sh
export GITHUB_WEBHOOK_SECRET='…'
./scripts/replay-github-webhook.sh \
  -u "https://<host>/api/github/webhook" \
  -d "u1-proof-<your-id>" \
  --replay
```

Or trigger a real allowlisted issue/PR event; record delivery id from GitHub **Recent Deliveries**.

## F. Disable path

| Field | Value |
| --- | --- |
| Agent disabled at (UTC) | |
| New delivery while disabled → no new execution | yes / no |
| Agent re-enabled after test | yes / no |

## G. Rollback rehearsal

| Field | Value |
| --- | --- |
| Set `SHIPWRIGHT_ROLLOUT_STAGE=disabled` + restart (UTC) | |
| `/readyz` after rollback | pass / fail |
| No new trigger executions after rollback | yes / no |

## H. Close td-fae961

When A–G are complete:

```sh
td log td-fae961 --note "U1 proof complete: dry_run + idempotent delivery <id>; pin @ <sha>"
td review td-fae961   # or td approve from independent session if required
```

## Related

- [always-on-activation.md](./always-on-activation.md)
- Fixtures: `test/fixtures/github-webhook/`
- Vitest contract: `ui/server/github-webhook.spec.ts` (“deduplicates its replay”)
