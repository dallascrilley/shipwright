---
date: 2026-07-25
topic: always-on-activation
---

# Always-on activation runbook (dry-run first)

Activate Shipwright's remote control plane so signed GitHub events can enqueue **dry-run** agent executions. Publication stays off until a later stage with explicit security and cost notes (see [publish-stage-criteria.md](publish-stage-criteria.md)).

## Preconditions

- Production VM deployed per [docs/deployment.md](../deployment.md)
- `/etc/shipwright/shipwright.env` and `/etc/shipwright/github-app.pem` installed (`root:shipwright`, env `0640`, key not world-readable)
- `GITHUB_REPOSITORY_ALLOWLIST` includes the intended owners (typically `dallascrilley/*,DallasCrilleyMarTech/*`)
- GitHub App installed on the repositories you will watch
- Public HTTPS edge (or equivalent) so GitHub can reach the webhook URL
- Operator can reach the console over Tailscale and authenticate with Better Auth
- Current stage is `disabled` (default) unless you are resuming a partial activation

## Rollback (keep this ready)

At any step:

```sh
# on the pin, as root/operator with sudo
sudo sed -i 's/^SHIPWRIGHT_ROLLOUT_STAGE=.*/SHIPWRIGHT_ROLLOUT_STAGE=disabled/' /etc/shipwright/shipwright.env
sudo systemctl restart shipwright
curl -fsS http://127.0.0.1:PORT/readyz   # expect 200 once ready
```

Replace `PORT` with the service loopback port from the unit file. Rollback does **not** delete agent definitions or history; it stops the scheduler/worker from claiming new trigger work.

Optional: temporarily disable the GitHub App webhook delivery in GitHub settings if deliveries should stop entirely.

## Stage ladder

| Stage | Worker behavior | Use when |
| --- | --- | --- |
| `disabled` | No scheduler/queue worker | Default / rollback |
| `test_only` | Claims **operator test runs** only; publish forced off | Prove console → queue → pipeline without GitHub |
| `dry_run` | Scheduler + GitHub triggers enqueue; publish forced off | First always-on proof |
| `approval_required` | Same forced-off publish at queue boundary; confirmation semantics remain | Later |
| `publish_allowed` | Publish only if revision policy is also `publish_allowed` | Later, per-agent, after the publish-stage gates |

Advance **one stage at a time**. Do not skip to `publish_allowed` in this runbook.

## Step 1 — Confirm baseline health (`disabled`)

1. SSH/Tailscale to the pin.
2. Confirm env stage:

   ```sh
   grep '^SHIPWRIGHT_ROLLOUT_STAGE=' /etc/shipwright/shipwright.env
   ```

3. Probe loopback:

   ```sh
   curl -fsS http://127.0.0.1:PORT/healthz
   curl -fsS http://127.0.0.1:PORT/readyz
   curl -fsS http://127.0.0.1:PORT/metrics | head
   ```

4. In the console, open Agents and Operator history; note that queued test work (if any) is not claimed while disabled.

**Exit criteria:** healthz/readyz 200; stage `disabled`; no surprise publish.

## Step 2 — Configure webhook secret and callback

1. Generate a high-entropy webhook secret; store only in the host env and the GitHub App webhook settings (1Password / existing secret inventory). Never commit it.
2. Set on the pin:

   ```dotenv
   GITHUB_WEBHOOK_SECRET=...
   SHIPWRIGHT_PUBLIC_HOST=your.public.host
   ```

3. In the GitHub App settings, configure:

   - URL: `https://<SHIPWRIGHT_PUBLIC_HOST>/api/github/webhook`
   - Content type: `application/json`
   - Secret: same as `GITHUB_WEBHOOK_SECRET`
   - Events: **Issues**, **Pull requests**, and **Pull request reviews**
   - Add **Check suites** only when `SHIPWRIGHT_SYMPHONY_WEBHOOK_URL` is configured

   The public edge accepts only `POST /api/github/webhook`. It returns `404`
   for the console, health, metrics, and every other path or method.

   To use review triggers, also pin the one reviewer identity you accept.
   Shipwright rejects every review delivery while this is unset:

   ```dotenv
   GITHUB_REVIEW_BOT_LOGIN=your-reviewer[bot]
   # optional, narrows further
   GITHUB_REVIEW_BOT_USER_ID=...
   GITHUB_APP_INSTALLATION_ID=...
   ```

4. Redeploy or restart so the service loads the secret:

   ```sh
   sudo systemctl restart shipwright
   ```

5. From GitHub, use “Recent Deliveries” / ping if available. Expect `401` only for bad signatures; valid tests may `202` even when no agent matches.

**Exit criteria:** secret present only in env + GitHub; route reachable over HTTPS; invalid signature → 401.

## Step 3 — `test_only` proof

1. Set `SHIPWRIGHT_ROLLOUT_STAGE=test_only` and restart.
2. In Agents console, create or select a **disabled** agent on an allowlisted repo; run **Test run** (dry-run).
3. Confirm the queue worker claims the test entry and a redacted receipt appears.
4. Confirm GitHub deliveries (if any) do **not** start non-test work at this stage.

**Exit criteria:** manual test execution works; triggers still not autonomously executing production work.

## Step 4 — Create/enable a dry-run agent (still safe)

1. Keep publication policy `dry_run` on the agent revision.
2. Add a curated trigger (e.g. Issue created or Pull request created) for one allowlisted repo.
3. Use **Test run** again after trigger validation.
4. Explicitly **enable** the agent only after the test looks correct.
5. Leave rollout at `test_only` until you are ready for live trigger enqueue.

**Exit criteria:** enabled agent + validated trigger exist; still no live trigger execution until Step 5.

## Step 5 — Advance to `dry_run` and prove one signed delivery

1. Set `SHIPWRIGHT_ROLLOUT_STAGE=dry_run` and restart.
2. Trigger a real allowlisted event **or** replay a signed fixture against the public webhook path (`scripts/replay-github-webhook.sh --replay`; payloads in `test/fixtures/github-webhook/`).
3. Confirm:

   - exactly **one** queue/execution for the agent revision
   - replaying the same `X-GitHub-Delivery` does **not** create a second execution
   - receipt shows dry-run / non-publish outcome
   - no remote branch/PR/thread mutation from this proof

4. Disable the agent and deliver again → receipt/match evidence only, no new work.
5. Re-enable when finished.

**Exit criteria:** idempotent signed dry-run execution proven; disable path safe; rollback procedure rehearsed once.

## Step 6 — Record evidence

Record the following alongside the deploy, with no secrets:

- pin commit / deploy revision
- stage transitions with timestamps
- webhook App id / installation scope (no secrets)
- agent id + revision + repository
- delivery id (or fixture name) and resulting execution id
- confirmation that publish did not occur
- any rollback test performed

## Explicit non-goals for this runbook

- Setting `approval_required` or `publish_allowed`
- Resolving PR review threads or pushing commits from triggers
- Multi-repo blast radius changes

Those belong to the later publish-stage gates in [publish-stage-criteria.md](publish-stage-criteria.md).

## Related

- Staged rollout table: [docs/deployment.md](../deployment.md)
