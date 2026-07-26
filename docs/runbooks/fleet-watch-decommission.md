---
date: 2026-07-25
topic: fleet-watch-decommission
origin: docs/plans/2026-07-25-feat-always-on-watched-repo-automations-plan.md
td: td-eafee0
---

# Fleet PR watch decommission (one repo)

Replace the local poller as the **primary** PR feedback path for **one** fleet repo with a Shipwright agent on the remote pin. Keep `fleet-pr-watch.py` for repos not yet covered.

Related: [always-on-activation.md](always-on-activation.md), [publish-stage-criteria.md](publish-stage-criteria.md), `.agents-state/fleet-pr-watch.json`.

## Preconditions (all required)

- [ ] U1 complete on remote pin: stage at least `dry_run`, signed webhook delivery enqueued exactly one sandbox run, replay idempotent ([always-on-activation.md](always-on-activation.md))
- [ ] U4 checklist understood; decommission stays at **dry_run** until operator fills publish sign-off ([publish-stage-criteria.md](publish-stage-criteria.md))
- [ ] GitHub App installed on the target repo with issues + pull requests + contents (as documented in deployment)
- [ ] Repository allowlisted in Shipwright host config

## Recommended first candidate

| Field | Value |
| --- | --- |
| Slug | `orca-shepherd` |
| GitHub | `dallascrilley/orca-shepherd` |
| Rationale | Operator-owned repo, typically low open-PR churn in fleet snapshots, good dry-run canary before Martech repos |

## Agent to create

1. Agents console → template **PR opened → Resolve PR feedback**
2. Repository: `dallascrilley/orca-shepherd`
3. Leave **disabled** until draft reviewed; `publicationPolicy: dry_run`
4. GitHub trigger: `pull_request` / `opened` (document any extra actions in td)
5. Queue a **test run** against a known open PR while stage is `dry_run`
6. **Enable** only after test receipt looks correct

## Prove webhook path (not poller)

1. Open or update a PR on the target repo (within allowlist)
2. Confirm Shipwright history shows a run from source `github` (not `test` only)
3. Confirm receipt: sandbox complete, no publish side effects at dry_run
4. Record receipt id(s) on td-eafee0

## Decommission poller for that slug only

Add to the repo entry in `.agents-state/fleet-pr-watch.json`:

```json
"watch_mode": "shipwright_primary",
"decommissioned_at": "2026-07-25T00:00:00Z",
"notes": "Primary PR feedback via Shipwright agent <agent-id>"
```

`fleet-pr-watch.py` skips repos with `watch_mode: shipwright_primary`.

Smoke: `python3 .agents-state/fleet-pr-watch.py`

## Rollback

1. Disable the agent in the console
2. Remove `watch_mode` / decommission fields from the repo entry

## Acceptance (U5)

- [ ] One fleet slug marked `shipwright_primary` with agent id noted
- [ ] Webhook-triggered dry_run history for that repo
- [ ] Poller skips that slug; other repos still polled
- [ ] td note with agent id + receipt ids
