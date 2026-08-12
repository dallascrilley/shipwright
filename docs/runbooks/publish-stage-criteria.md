---
date: 2026-07-25
topic: publish-stage-criteria
---

# Publish-stage security criteria (selective `publish_allowed`)

Advance beyond dry-run always-on only when the checklist below is satisfied. Publication remains a **double opt-in**: deployment `SHIPWRIGHT_ROLLOUT_STAGE` **and** the agent's pinned `publicationPolicy` must both be `publish_allowed`. Neither alone grants write authority.

Related: [always-on-activation.md](always-on-activation.md) (dry-run first), [deployment.md](../deployment.md).

## Non-goals

- Auto-merge
- Submitting or dismissing PR approvals
- Browser-held GitHub credentials
- Skipping allowlist, verification, exact-head, secret/patch, or branch-protection checks

## Double opt-in matrix

`canPublishAtStage(stage, publicationPolicy)` is true **only** when both are `publish_allowed`.

| Stage \ Policy | `dry_run` | `approval_required` | `publish_allowed` |
| --- | --- | --- | --- |
| `disabled` | no | no | no |
| `test_only` | no | no | no |
| `dry_run` | no | no | no |
| `approval_required` | no | no | no |
| `publish_allowed` | no | no | **yes** |

At the queue-runner boundary, `publish` is forced false whenever the matrix says no. Review dry-runs therefore return before push/reply/resolve (`src/pipeline/review-run.ts`).

## Gate checklist before any `publish_allowed` agent

Record the evidence for each box below before changing stage or revision policy.

### A. Dry-run always-on proof

- [ ] Remote pin completed [always-on-activation.md](always-on-activation.md) through `dry_run`
- [ ] Signed webhook delivery enqueued exactly one dry-run; replay did not duplicate
- [ ] Rollback to `disabled` verified at least once

### B. Agent configuration

- [ ] Agent created disabled from a curated template or equivalent
- [ ] `actionPreset` matches trigger family (`fix_issue` ↔ issues, `resolve_pr_feedback` ↔ pull_request)
- [ ] Repository is App-accessible and allowlisted; start-time reauthorization still applies
- [ ] Verification preset/command is known-good for that repository
- [ ] Instructions are pinned on an immutable revision you intend to enable

### C. Safety invariants still authoritative

- [ ] Secret/patch policy unchanged (no secret-like publishable patches)
- [ ] Exact-head and open-PR checks remain on the publish path
- [ ] Branch protections are not bypassed
- [ ] Emergency stop / stage rollback procedure is known to the operator

### D. Cost and teardown (R12)

Record in td before enabling publish:

| Field | Value |
| --- | --- |
| Monthly / per-run ceiling | _(fill)_ |
| Idle-cost behavior | Control plane always-on; workers ephemeral / scale to zero |
| Teardown | Set stage `disabled`, disable agent, optionally disable webhook; export `/var/lib/shipwright` if retiring the VM |
| Owner | Single operator |
| Monitoring | `/healthz`, `/readyz`, `/metrics` + existing lease/dead-letter alerts |

### E. Security sign-off (R12)

- [ ] Webhook secret only in host env + GitHub App settings
- [ ] GitHub App permissions still least-privilege (metadata/issues/contents/PRs as documented)
- [ ] No secrets in receipts, Copy-as-JSON, or metrics labels
- [ ] Operator explicitly signs off on **this agent revision** for unattended publish

## Stage ladder after dry-run

1. **Remain at `dry_run`** until A–C are green for the candidate agent.
2. **`approval_required` (optional intermediate)**  
   - Set `SHIPWRIGHT_ROLLOUT_STAGE=approval_required`.  
   - Queue boundary still forces `publish: false`.  
   - Use for operational confidence; do not treat as unattended publish.
3. **`publish_allowed` deployment stage**  
   - Only after A–E.  
   - Set stage in `/etc/shipwright/shipwright.env`, restart, confirm `/readyz` and metrics show the stage.
4. **Per-agent revision opt-in**  
   - Edit the agent: `publicationPolicy: publish_allowed` on a **new revision**.  
   - Keep agent disabled until the revision is reviewed.  
   - Enable explicitly. Historical dry-run revisions are unchanged.

## Prove review non-mutation at dry-run

Before raising stage:

1. Enable a `resolve_pr_feedback` agent with `publicationPolicy: dry_run` against an allowlisted PR.
2. Trigger via test run or signed `pull_request` delivery while stage is `dry_run`.
3. Confirm receipt completes without `publish` phase side effects: no new commit on the PR head, no new review replies/resolves from this run.
4. Retain the receipt id in the td note.

When stage **and** policy are `publish_allowed`, the same agent may push and reply/resolve under existing gates; failures must leave redacted receipts and must not retry-storm.

## Rollback

```sh
# Force all publication off immediately
sudo sed -i 's/^SHIPWRIGHT_ROLLOUT_STAGE=.*/SHIPWRIGHT_ROLLOUT_STAGE=disabled/' /etc/shipwright/shipwright.env
sudo systemctl restart shipwright

# Or keep triggers but strip publish authority
sudo sed -i 's/^SHIPWRIGHT_ROLLOUT_STAGE=.*/SHIPWRIGHT_ROLLOUT_STAGE=dry_run/' /etc/shipwright/shipwright.env
sudo systemctl restart shipwright
```

Also disable the specific agent in the console (audited lifecycle event). Disabling the agent stops new enqueue for that agent; lowering the stage stops publish globally.

## td note template

```text
Publish-stage sign-off for agent <id> revision <n>
- Dry-run proof receipt(s): …
- Webhook replay idempotent: yes/no
- Verify preset: …
- Cost ceiling: …
- Teardown path: stage disabled + agent disable
- Security: webhook secret host-only; App scope unchanged; no receipt secrets
- Operator sign-off: <name> <date>
- Then: SHIPWRIGHT_ROLLOUT_STAGE=publish_allowed AND publicationPolicy=publish_allowed
```

## Acceptance

- [x] Checklist documents dry-run proof, verify, allowlist, secret policy, exact-head, cost, teardown, security sign-off
- [x] Double opt-in matrix documented and covered by unit tests
- [x] Review dry-run non-mutation called out with pipeline reference
- [ ] Live pin has not been raised to `publish_allowed` without a recorded operator sign-off
