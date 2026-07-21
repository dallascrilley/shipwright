#!/usr/bin/env bash
# Backup and restore the durable Shipwright control-plane snapshot.
#
#   deploy/control-plane-state.sh backup  <state_dir> <backup_dir>
#   deploy/control-plane-state.sh restore <backup_file> <state_dir>
#
# The snapshot is a single JSON document. Backup copies it atomically and
# records a SHA-256 checksum. Restore validates the JSON parses before an
# atomic move, so a corrupt backup never replaces the live snapshot.
set -euo pipefail

command_name="${1:-}"
state_file="agent-control-plane.json"

usage() {
  printf 'Usage: %s backup <state_dir> <backup_dir> | restore <backup_file> <state_dir>\n' "$0" >&2
  exit 1
}

[[ "$command_name" == "backup" || "$command_name" == "restore" ]] || usage

if [[ "$command_name" == "backup" ]]; then
  state_dir="${2:-}"
  backup_dir="${3:-}"
  [[ -n "$state_dir" && -n "$backup_dir" ]] || usage
  source_path="$state_dir/$state_file"
  [[ -f "$source_path" ]] || { printf 'No control-plane snapshot at %s\n' "$source_path" >&2; exit 1; }
  mkdir -p "$backup_dir"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  destination="$backup_dir/$state_file.$stamp"
  temporary="$destination.tmp.$$"
  cp "$source_path" "$temporary"
  mv "$temporary" "$destination"
  chmod 600 "$destination"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$destination" | awk '{print $1}' > "$destination.sha256"
  else
    sha256sum "$destination" | awk '{print $1}' > "$destination.sha256"
  fi
  printf 'Backed up %s to %s\n' "$source_path" "$destination"
else
  backup_file="${2:-}"
  state_dir="${3:-}"
  [[ -n "$backup_file" && -n "$state_dir" ]] || usage
  [[ -f "$backup_file" ]] || { printf 'No backup at %s\n' "$backup_file" >&2; exit 1; }
  if [[ -f "$backup_file.sha256" ]]; then
    recorded="$(awk '{print $1}' "$backup_file.sha256")"
    if command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "$backup_file" | awk '{print $1}')"
    else
      actual="$(sha256sum "$backup_file" | awk '{print $1}')"
    fi
    if [[ "$recorded" != "$actual" ]]; then
      printf 'Checksum mismatch for %s; refusing to restore.\n' "$backup_file" >&2
      exit 1
    fi
  fi
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  SCHEMA_MODULE="$script_dir/../ui/shared/agent-definition.ts" bun -e '
    const mod = await import(process.env.SCHEMA_MODULE);
    const parsed = JSON.parse(await Bun.file(process.argv[1]).text());
    mod.agentControlPlaneSnapshotSchema.parse(parsed);
  ' "$backup_file" || { printf 'Backup %s is not a valid control-plane snapshot; live state untouched.\n' "$backup_file" >&2; exit 1; }
  mkdir -p "$state_dir"
  live="$state_dir/$state_file"
  if [[ -f "$live" ]]; then
    cp "$live" "$live.bak"
    chmod 600 "$live.bak"
  fi
  temporary="$state_dir/$state_file.restore.$$"
  cp "$backup_file" "$temporary"
  mv "$temporary" "$live"
  chmod 600 "$live"
  printf 'Restored %s into %s (previous state retained as %s.bak)\n' "$backup_file" "$live" "$live"
fi
