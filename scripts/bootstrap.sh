#!/usr/bin/env bash
set -euo pipefail

script_directory="${BASH_SOURCE[0]%/*}"
cd "$script_directory/.."
repo_root="$PWD"

run_tool() {
  if command -v mise >/dev/null 2>&1; then
    mise exec -- "$@"
  else
    "$@"
  fi
}

if command -v mise >/dev/null 2>&1; then
  mise trust "$repo_root/mise.toml" >/dev/null
  mise install
else
  for command_name in bun node corepack; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      printf 'Missing %s. Install mise or the pinned runtimes in mise.toml.\n' "$command_name" >&2
      exit 1
    fi
  done
fi

run_tool corepack enable

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  printf 'Created .env from .env.example; add secret values before a live run.\n'
fi

run_tool bun install --frozen-lockfile
(
  cd ui
  run_tool pnpm install --frozen-lockfile
)
sandbox_image="${SHIPWRIGHT_SANDBOX_IMAGE:-}"
if [[ -z "$sandbox_image" && -f .env ]]; then
  sandbox_image="$(sed -n 's/^SHIPWRIGHT_SANDBOX_IMAGE=//p' .env | tail -n 1)"
fi
sandbox_image="${sandbox_image:-rivetdev/sandbox-agent@sha256:640cfb725a94b8a47967e0c2ec153d3ab267244f517f700e8f82f1e4d55b2ea2}"
if [[ ! "$sandbox_image" =~ @sha256:[0-9a-f]{64}$ ]]; then
  printf 'SHIPWRIGHT_SANDBOX_IMAGE must use an immutable sha256 digest.\n' >&2
  exit 1
fi
export SHIPWRIGHT_SANDBOX_IMAGE="$sandbox_image"
docker pull "$sandbox_image" >/dev/null
run_tool bun run provision:sandbox-bun
run_tool bun run doctor -- --runtime-only

printf 'Shipwright bootstrap complete. Run bun run doctor after configuring .env.\n'
