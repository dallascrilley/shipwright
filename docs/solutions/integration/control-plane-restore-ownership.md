---
title: Atomic restore must preserve the control-plane service owner
date: 2026-07-22
category: integration
module: production-control-plane
tags: [backup, restore, ownership, systemd, readiness]
severity: high
---

# Atomic restore must preserve the control-plane service owner

## Problem

Restoring a valid control-plane backup as `root` passed schema and checksum
validation but replaced `/var/lib/shipwright/agent-control-plane.json` with a
`root:root` mode-`0600` file. The `shipwright` systemd service could no longer
read its durable state, so `/readyz` returned HTTP 503 with `EACCES` even though
the restored bytes were correct.

## Root cause

`deploy/control-plane-state.sh restore` copied the backup into a new temporary
file, atomically moved that file over the live snapshot, and applied mode
`0600`. An atomic move preserves the temporary file's ownership. Because the
operator invoked the command as `root`, the replacement remained owned by
`root`; changing only its mode then excluded the service user.

## Solution

Before creating the replacement, restore captures the numeric owner and group
from the existing live snapshot. When no live snapshot exists, it uses the
state directory's owner and group. It then:

1. validates the backup before touching live state;
2. copies the backup to a temporary file in the state directory;
3. applies mode `0600` and the captured owner to that temporary file;
4. retains the displaced live snapshot as `.bak`; and
5. atomically moves the prepared file into place.

Ownership preparation therefore fails before the atomic replacement. The
`SHIPWRIGHT_STATE_OWNER=<uid>:<gid>` override exists for deliberate recovery
operations and tests; it accepts numeric IDs only.

## Verification

`test/deploy/control-plane-state.test.ts` injects a controlled `chown` and
asserts it targets the `.restore.<pid>` temporary path, not the live snapshot.
The existing round-trip, corrupt-backup, checksum, `.bak`, hostile-`CDPATH`,
and missing-state tests remain part of the same focused suite.

For a production drill, compare the state checksum before and after restore,
confirm the live file is `shipwright:shipwright` with mode `0600`, restart the
service, and require both `/healthz` and `/readyz` to return HTTP 200.

## Prevention

Treat mode and ownership as part of an atomic file's data contract. Prepare all
three on the temporary inode before replacement, and include a service-user
readiness probe in every privileged restore drill.
