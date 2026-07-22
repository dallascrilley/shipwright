#!/usr/bin/env bash
set -euo pipefail

target="${1:-}"
if [[ -z "$target" ]]; then
  printf 'Usage: deploy/deploy.sh <ssh-target>\n' >&2
  exit 1
fi

script_directory="${BASH_SOURCE[0]%/*}"
cd "$script_directory/.."

if [[ -n "$(git status --porcelain)" ]]; then
  printf 'Refusing to deploy a dirty checkout. Commit the exact reviewed release first.\n' >&2
  exit 1
fi

release_id="$(git rev-parse HEAD)"
release_path="/opt/shipwright/releases/$release_id"

ssh "$target" 'bash -s' < deploy/bootstrap-host.sh
ssh "$target" bash -s -- "$release_path" <<'REMOTE'
set -euo pipefail
release_path="$1"
install -d -o shipwright -g shipwright -m 755 "$release_path"
REMOTE
rsync -a --delete \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude '.artifacts/' \
  --exclude 'node_modules/' \
  --exclude 'ui/node_modules/' \
  --exclude 'ui/build/' \
  --exclude 'ui/.output/' \
  ./ "$target:$release_path/"

ssh "$target" bash -s -- "$release_path" <<'REMOTE'
  set -euo pipefail
  release_path="$1"
  chown -R shipwright:shipwright "$release_path"
  test -s /etc/shipwright/shipwright.env
  set -a
  # shellcheck disable=SC1091 -- production configuration is intentionally host-local.
  . /etc/shipwright/shipwright.env
  set +a
  test -n "${BETTER_AUTH_SECRET:-}"
  test -n "${GITHUB_APP_PRIVATE_KEY_PATH:-}"
  test -n "${SHIPWRIGHT_SANDBOX_IMAGE:-}"
  if [[ ! "$SHIPWRIGHT_SANDBOX_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]; then
    printf 'SHIPWRIGHT_SANDBOX_IMAGE must use an immutable sha256 digest.\n' >&2
    false
  fi
  stage="${SHIPWRIGHT_ROLLOUT_STAGE:-disabled}"
  case "$stage" in
    disabled|test_only|dry_run|approval_required|publish_allowed) ;;
    *)
      printf 'SHIPWRIGHT_ROLLOUT_STAGE must be one of disabled, test_only, dry_run, approval_required, publish_allowed.\n' >&2
      false
      ;;
  esac
  runuser -u shipwright -- test -r "$GITHUB_APP_PRIVATE_KEY_PATH"
  docker pull "$SHIPWRIGHT_SANDBOX_IMAGE" >/dev/null
  runuser -u shipwright -- /usr/local/bin/mise trust "$release_path/mise.toml" >/dev/null
  runuser -u shipwright -- /usr/local/bin/mise install -C "$release_path"
  runuser -u shipwright -- /usr/local/bin/mise exec -C "$release_path" -- corepack enable
  runuser -u shipwright -- /usr/local/bin/mise exec -C "$release_path" -- bun install --frozen-lockfile
  runuser -u shipwright -- /usr/local/bin/mise exec -C "$release_path/ui" -- pnpm install --frozen-lockfile
  runuser -u shipwright -- /usr/local/bin/mise exec -C "$release_path/ui" -- pnpm build
  runuser --preserve-environment -u shipwright -- \
    env HOME=/var/lib/shipwright \
    /usr/local/bin/mise exec -C "$release_path" -- bun run doctor

  previous_release=""
  if [[ -L /opt/shipwright/current ]]; then
    previous_release="$(readlink -f /opt/shipwright/current)"
  fi
  previous_unit=/run/shipwright.service.previous
  if [[ -f /etc/systemd/system/shipwright.service ]]; then
    cp -p /etc/systemd/system/shipwright.service "$previous_unit"
  else
    rm -f "$previous_unit"
  fi

  switched=0
  rollback() {
    trap - ERR
    if [[ -f "$previous_unit" ]]; then
      cp -p "$previous_unit" /etc/systemd/system/shipwright.service
    fi
    if [[ -n "$previous_release" ]]; then
      ln -sfn "$previous_release" /opt/shipwright/current.rollback
      mv -Tf /opt/shipwright/current.rollback /opt/shipwright/current
      systemctl daemon-reload
      systemctl restart shipwright || true
    elif [[ "$switched" -eq 1 ]]; then
      unlink /opt/shipwright/current 2>/dev/null || true
      systemctl stop shipwright || true
    fi
  }
  trap rollback ERR

  install -o root -g root -m 644 "$release_path/deploy/shipwright.service" /etc/systemd/system/shipwright.service
  ln -sfn "$release_path" /opt/shipwright/current.next
  mv -Tf /opt/shipwright/current.next /opt/shipwright/current
  switched=1
  systemctl daemon-reload
  systemctl enable --now shipwright
  systemctl restart shipwright

  healthy=0
  for _ in {1..30}; do
    if curl -fsS http://127.0.0.1:4317/healthz >/dev/null \
      && curl -fsS http://127.0.0.1:4317/readyz >/dev/null; then
      healthy=1
      break
    fi
    sleep 2
  done
  if [[ "$healthy" -ne 1 ]]; then
    systemctl status shipwright --no-pager >&2 || true
    journalctl -u shipwright -n 80 --no-pager >&2 || true
    false
  fi

  trap - ERR
  rm -f "$previous_unit"

  # Optional public HTTPS edge. The release is already healthy on loopback, so
  # the app-rollback trap is intentionally cleared above; a Caddy failure fails
  # the deploy without reverting a healthy service.
  if [[ -n "${SHIPWRIGHT_PUBLIC_HOST:-}" ]]; then
    if ! command -v caddy >/dev/null 2>&1; then
      apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
      curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
        -o /etc/apt/sources.list.d/caddy-stable.list
      apt-get update
      apt-get install -y caddy
    fi
    install -d -m 755 /etc/caddy
    sed "s|%%PUBLIC_HOST%%|${SHIPWRIGHT_PUBLIC_HOST}|g" \
      "$release_path/deploy/Caddyfile" > /etc/caddy/Caddyfile
    caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
    if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
      ufw allow 80/tcp
      ufw allow 443/tcp
    fi
    systemctl enable --now caddy
    systemctl reload caddy || systemctl restart caddy
    printf 'Caddy public edge configured for %s.\n' "$SHIPWRIGHT_PUBLIC_HOST"
  else
    printf 'SHIPWRIGHT_PUBLIC_HOST unset; public edge not configured (Tailscale-only).\n'
  fi
REMOTE

printf 'Shipwright deployed and healthy at commit %s.\n' "$release_id"
