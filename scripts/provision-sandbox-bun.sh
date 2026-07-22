#!/usr/bin/env bash
set -euo pipefail

bun_version="1.3.14"
bun_image="oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4"
destination="${SHIPWRIGHT_SANDBOX_BUN_PATH:-${HOME:?HOME must be set}/.shipwright/tools/bun-${bun_version}-linux}"
if [[ "$destination" != /* ]]; then
  printf 'SHIPWRIGHT_SANDBOX_BUN_PATH must be an absolute path.\n' >&2
  exit 1
fi
destination_directory="${destination%/*}"
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/shipwright-bun.XXXXXX")"
container_id=""
next_path="${destination}.next.$$"

cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$temporary_directory"
  rm -f "$next_path"
}
trap cleanup EXIT

docker pull "$bun_image" >/dev/null
container_id="$(docker create "$bun_image")"
docker cp -L "${container_id}:/usr/local/bin/bun" "$temporary_directory/bun"

actual_version="$(docker run --rm --entrypoint /usr/local/bin/bun "$bun_image" --version)"
if [[ "$actual_version" != "$bun_version" ]]; then
  printf 'Pinned sandbox Bun image returned %s; expected %s.\n' "$actual_version" "$bun_version" >&2
  exit 1
fi

install -d -m 700 "$destination_directory"
install -m 755 "$temporary_directory/bun" "$next_path"
mv -f "$next_path" "$destination"

printf 'Provisioned sandbox Bun %s from %s at %s.\n' "$bun_version" "$bun_image" "$destination"
