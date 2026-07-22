---
title: Bun verification presets failed inside the disposable sandbox
date: 2026-07-22
category: integration
module: sandbox-runtime
tags: [bun, docker, verification, mise, toolchain]
severity: high
related: [docs/solutions/integration/openai-codex-oauth-fallback.md]
---

# Bun verification presets failed inside the disposable sandbox

## Problem

A production dry run completed model work, then the independent `bun test` verification failed with `sh: 1: bun: not found` and exit 127. Shipwright offered the preset and pinned Bun in `mise.toml`, but the pinned `rivetdev/sandbox-agent` image did not contain Bun.

## What didn't work

Mounting the active host executable is not portable: local macOS Bun binaries cannot execute inside Linux Docker containers. Installing from the network during an agent run would also make verification mutable and consume time after provider work had already started.

## Solution

`scripts/provision-sandbox-bun.sh` pulls the immutable multi-architecture `oven/bun` image, verifies version 1.3.14, extracts its Linux executable to the Shipwright tool cache, and installs it atomically. Bootstrap, deployment, and `bun run test:docker` invoke the provisioner.

`src/sandbox/runtime.ts` validates the cached file, mounts it read-only at `/usr/local/bin/bun`, and runs an exact-version preflight during workspace initialization. The preflight precedes repository clone and model execution.

Repair or refresh the cache with:

```bash
bun run provision:sandbox-bun
```

## Why it works

The executable comes from a digest-pinned Linux image selected for Docker's current architecture, so the same provisioning path works on macOS/ARM development hosts and Linux/x86 production. Mounting at `/usr/local/bin/bun` also survives the verification command's login shell rebuilding `PATH`.

## Prevention

Keep `mise.toml`, `EXPECTED_SANDBOX_BUN_VERSION`, and the provisioner version synchronized. The unit contract checks that alignment, the doctor checks the cache before service use, and the opt-in Docker test executes `bun --version` inside a fresh sandbox.
