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

## Review delivery and recovery

The host retains a repair candidate under `review-candidates/` with the
authorized base/head, patch, changed files, host-derived finding source,
task/run/actor provenance, fix-group assignment, verification metadata, and
evidence-token references. Host verification records and plans are stored
under `review-verifications/` and `review-verification-plans/`. The effect
journal under `review-effects/` records the ownership-bound delivery plan,
effect intent/confirmation state, and resume cursor. Use `--candidate-id <id>`
to load these records for a resumed run; do not edit or remove them by hand.
Publication uses host verification, not the model's proposal or repair
identity, as its closure authority.

Ownership IDs are host-authored local task identities, not GitHub repository
owners or reviewer logins. For follow-up delivery, `--owner-id` names the task
owner. For an explicit handoff, `--handoff-from-owner` names that same task
owner while `--owner-id` names the receiving operator. Candidate provenance
uses this host-owned identity and never derives local ownership from PR metadata.

- `patch` (the CLI default) and `evidence-only` retain local evidence and make
  no remote commit, push, reply, or resolution, even when `--publish` is set.
- `follow-up-pr` is the default for a published review run. It requires
  `--owner-id`, commits the candidate on a separate branch, and opens or
  reuses a follow-up PR whose base is the original PR's head branch. It does
  not reply to or resolve the original threads. The selected base SHA defaults
  to the retained candidate's immutable authorized head; any supplied base
  must match it. Replay uses the original PR head without an implicit rebase.
- `commit` requires `--owner-id`, `--handoff-from-owner`, `--handoff-id`, and
  `--authorized-by`. It commits and pushes changed files to the authorized
  pull request, then replies to and resolves host-verified findings.
  `needs-human` findings remain open.

Missing or conflicting ownership, stale candidate/review content, remote
base/head movement, and effect-journal drift fail closed. A candidate with
multiple independent fix groups must be delivered through separately scoped
candidates; duplicate findings may share one explicitly host-assigned group
and one commit. Every candidate commit is bound to its source findings in the
receipt. Scope a run with repeated `--finding-id` plus either `--review-id` or
the preflight-pinned `--review-head-sha`; the effect journal records the
selected finding IDs so a resume cannot widen the delivery.

Direct commit lifecycle is `proposed` → `integrated` → `verified`: after the
push, the host proves the remote head contains the generated commit, runs the
whole verification command in a fresh host workspace at that exact resulting
head, and re-runs each selected finding's host-owned behavioral proof there.
Only a complete set of passing finding proofs permits replies or resolutions.
A failed post-integration check or finding proof leaves the original findings
open. Follow-up lifecycle is `proposed` → `delivered`; a later candidate resume
can recognize the original PR head after the owner integrates the candidate,
including a squash or additional changes, prove original-head ancestry with
host Git, run fresh whole and per-finding verification at the resulting head,
and only then reply to and resolve the original findings. Textual patch
equality is not required for an owner-modified repair.

Every receipt reports authorized base freshness (`fresh`, `stale`, or
`unavailable`) and names `original-pr-owner` as integration owner. Shipwright
does not refresh the PR's Current base or merge the original owner's branch.

## Repair-publication rollout (staging only)

This source change does not activate production, unattended publication, or
any Hub2 workflow. Perform the following only against an explicitly selected
allowlisted staging PR after the stage/policy gates above are satisfied.

### Prerequisites

- Exact deployed source revision and receipt directory recorded.
- `dry_run` proof complete; verification command is known-good for the target.
- Operator can identify the original PR owner and the candidate's exact
  authorized head SHA.
- Local-owner authorization is recorded for follow-up delivery, or a complete
  explicit handoff is recorded for direct delivery.
- Candidate scope is one bounded fix group; independent groups have separate
  candidate IDs and runs.
- No concurrent writer owns the original PR head; branch protections remain
  enabled.

### Activation

1. Start with a dry-run or `patch` delivery and retain its candidate ID.
2. Inspect the receipt's source, provenance, fix group, verification record,
   authorized base/head, and changed files.
3. For the safer route, publish with `--owner-id <original-owner>` and
   `--delivery-mode follow-up-pr` (or omit the mode).
4. Use direct `--delivery-mode commit` only with the complete explicit handoff
   fields. Never infer ownership from a review comment or model output.
5. Confirm the effect journal and receipt before treating delivery as complete.

### Live validation

For the selected staging PR, verify that the original head did not change for
follow-up delivery, the follow-up PR targets the original head branch, its
head equals the candidate commit, and the original findings remain open.
For direct delivery, verify the receipt contains the exact resulting head,
commit-inclusion proof, and a passing fresh-workspace integration check before
confirming replies/resolutions. Re-run the same operation with a moved head or
conflicting ownership in a safe fixture; it must stop without a new remote
write. Record the run ID, candidate ID, exact SHAs, effect outcomes, and
verification exit codes without recording credentials.

### Rollback

Set the deployment stage back to `disabled` (or `dry_run` to keep triggers but
strip publish authority), restart the service, and disable the selected agent.
Do not delete candidate/effect evidence. A delivered follow-up remains an
ordinary PR for its owner to review or close. If a direct commit must be
reversed, use the repository owner's normal reviewed revert process; Shipwright
does not force-push or silently rewrite the original branch.

## Review artifact retention

The Shipwright host owns cleanup of durable review candidates, verification
records/plans, and effect journals. Run the bounded cleanup command from the
same checkout and state directory as the control plane; do not remove these
files by hand. The CLI defaults to 30 days and accepts
`--max-age-days <1-3650>`; age is evaluated from each artifact's recorded
`createdAt`, not filesystem modification time. It prints a JSON summary and
returns a nonzero status with a redacted error when the sweep cannot run:

```sh
# Inspect the 30-day sweep without deleting anything
SHIPWRIGHT_STATE_DIR=/var/lib/shipwright bun run review-retention -- --dry-run

# The scheduled host job may apply the same policy
SHIPWRIGHT_STATE_DIR=/var/lib/shipwright bun run review-retention -- --max-age-days 30
```

The command purges only aged, settled candidates and their associated journals,
plus aged verification records/plans that are not referenced by a remaining
candidate. Candidates whose own or journal effects are `intent` or `ambiguous`,
whose state is unreadable/malformed, or whose effect journal is missing while
the candidate carries effects are retained for recovery. Verification
records/plans remain when referenced by any retained candidate; malformed
records/plans are left untouched. Lock inodes are retained even after a JSON
artifact is purged. A dry run never deletes anything. The operator owns
scheduling, dry-run review, and receipt retention; no production purge is
performed by the review agent itself.

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
