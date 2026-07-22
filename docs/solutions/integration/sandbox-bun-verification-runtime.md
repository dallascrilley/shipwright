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

## Production verification

Release `91b9c920decee41766676598bbeecffc1780c79c` provisioned the cached Linux binary as `shipwright:shipwright` mode 0755. A fresh production `SandboxWorkspace` reported Bun 1.3.14 and passed a one-test `bun test` fixture through `workspace.verify()`.

No-publish receipt `cf10b590b73e2702` then retried `DallasCrilleyMarTech/example-service#276`: Kimi returned `capacity_failed`, `openai-codex/gpt-5.4` succeeded, and the independent `bun test` reached the repository gate with exit 1 instead of command-not-found exit 127. The receipt correctly ended as `verify_failed`; the authorized PR head and both unresolved review threads remained unchanged, and cleanup left zero sandbox containers or workspace directories.
