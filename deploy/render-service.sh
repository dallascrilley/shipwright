#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
shipwright_uid="${2:-}"
script_directory="${BASH_SOURCE[0]%/*}"

case "$mode" in
  rootful)
    exec cat "$script_directory/shipwright.service"
    ;;
  rootless|rootless-docker)
    if [[ ! "$shipwright_uid" =~ ^[0-9]+$ ]]; then
      printf 'A numeric Shipwright UID is required for %s mode.\n' "$mode" >&2
      exit 2
    fi
    if [[ "$mode" == rootless ]]; then
      template="$script_directory/shipwright-rootless.service"
    else
      template="$script_directory/shipwright-rootless-docker.service"
    fi
    sed "s/%%SHIPWRIGHT_UID%%/$shipwright_uid/g" "$template"
    ;;
  *)
    printf 'Docker mode must be rootful or rootless.\n' >&2
    exit 2
    ;;
esac
