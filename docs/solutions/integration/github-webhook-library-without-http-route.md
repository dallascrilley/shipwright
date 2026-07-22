---
title: A verified GitHub webhook library still needs a public HTTP route
date: 2026-07-22
category: integration
module: automation-trigger-ingress
tags: [github-webhook, h3, agent-native, idempotency, control-plane]
severity: high
---

# A verified GitHub webhook library still needs a public HTTP route

## Problem

Shipwright had a tested `GitHubWebhookIngress` that verified HMAC signatures,
bounded payloads, matched enabled repository-scoped triggers, and deduplicated
delivery IDs. Production still had no HTTP route under `ui/server/routes`, so a
GitHub App could not deliver an event. The signed offline fixture proved the
library but not the deployed protocol boundary.

## What didn't work

- Setting `GITHUB_WEBHOOK_SECRET` did not mount an endpoint.
- Calling `GitHubWebhookIngress.receive()` from an offline fixture bypassed the
  file-route loader and the Agent Native session-auth guard.
- Treating the library result as end-to-end proof left the real GitHub callback
  path untestable.

## Solution

Mount `POST /api/github/webhook` in
`ui/server/routes/api/github/webhook.post.ts:1`. The adapter asserts the 1 MiB
body limit before reading, passes the untouched body plus the three GitHub
headers to the existing ingress, and maps accepted, invalid-signature,
invalid-payload, and unavailable results to fixed HTTP responses.

`AgentManagementService.receiveGitHubWebhook()` in
`ui/server/agent-management.ts:272` constructs the ingress over the same
durable store and queue dispatcher used by the UI and worker. The auth plugin
lists only the exact callback prefix in `ui/server/plugins/auth.ts:10`; HMAC
verification remains the endpoint's authentication boundary.

The route integration spec in
`ui/server/routes/api/github/webhook.post.spec.ts:25` sends the same correctly
signed delivery twice through H3 and proves one durable queue entry remains.
It also covers the 1 MiB limit and fixed failure responses without retaining
the raw payload or exposing configuration details.

## Why it works

The missing layer was protocol wiring, not trigger logic. The file route makes
the ingress reachable while reusing its verify-before-parse behavior and the
singleton management service preserves delivery ID plus agent revision
idempotency in the production control-plane snapshot.

## Prevention

For webhook work, require one test at the actual HTTP adapter that sends a
signed request, observes durable queue state, replays the same delivery, and
observes no second entry. Library-only fixtures are necessary but never count
as endpoint proof.
