#!/usr/bin/env bash
# Loopback proof for Shipwright review-trigger rollout stages.
# Run on the production VM over Tailscale SSH; does not print secrets.
set -euo pipefail

expected_stage="${1:-}"
if [[ "${1:-}" == "--stage" ]]; then
  expected_stage="${2:-}"
fi
if [[ -z "$expected_stage" ]]; then
  printf 'usage: %s --stage <dry_run|approval_required|publish_allowed|test_only|disabled>\n' "$0" >&2
  exit 2
fi

base_url="${SHIPWRIGHT_LOOPBACK_URL:-http://127.0.0.1:4317}"

require_200() {
  local path="$1"
  local body
  body="$(curl -fsS "$base_url$path")"
  printf '%s %s\n' "$path" "$body"
}

printf 'checking service and loopback health at %s\n' "$base_url"
systemctl is-active shipwright
require_200 /healthz
require_200 /readyz

metrics="$(curl -fsS "$base_url/metrics")"
stage_line="$(printf '%s\n' "$metrics" | grep -E '^shipwright_rollout_stage\{' || true)"
if [[ -z "$stage_line" ]]; then
  printf 'missing shipwright_rollout_stage metric\n' >&2
  exit 1
fi
printf '%s\n' "$stage_line"

if ! printf '%s\n' "$stage_line" | grep -Fq "stage=\"$expected_stage\""; then
  printf 'expected rollout stage %s in metrics\n' "$expected_stage" >&2
  exit 1
fi

active_release="$(basename "$(readlink -f /opt/shipwright/current)")"
printf 'active_release=%s\n' "$active_release"
printf 'loopback readiness ok for stage %s\n' "$expected_stage"
printf 'next: send a signed review-comment delivery, confirm one coalesced dry-run execution, then advance publication only for the canary agent.\n'
