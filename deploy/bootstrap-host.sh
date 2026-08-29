#!/usr/bin/env bash
set -euo pipefail

next_subid_start() {
  local database="${1:--}"
  awk -F: '
    BEGIN { candidate = 100000 }
    NF >= 3 {
      range_end = $2 + $3
      if (range_end > candidate) candidate = range_end
    }
    END { print candidate }
  ' "$database"
}

if [[ "${1:-}" == "--next-subid-start" ]]; then
  next_subid_start "${2:--}"
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'Run bootstrap-host.sh as root.\n' >&2
  exit 1
fi

docker_mode="${1:-rootful}"
case "$docker_mode" in
  rootful|rootless) ;;
  *)
    printf 'Docker mode must be rootful or rootless.\n' >&2
    exit 2
    ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y build-essential ca-certificates curl git python3 rsync

if [[ "$docker_mode" == rootful ]]; then
  apt-get install -y docker.io
  systemctl enable --now docker
else
  apt-get install -y dbus-user-session slirp4netns uidmap
  if ! command -v dockerd >/dev/null 2>&1; then
    # The rootless daemon reuses the packaged engine and CLI binaries. The
    # freshly installed system daemon is stopped because rootless mode never
    # depends on it; a daemon that was already running for other tenants is
    # left untouched.
    apt-get install -y docker.io
    systemctl disable --now docker.service docker.socket 2>/dev/null || true
  fi
  if ! command -v dockerd-rootless-setuptool.sh >/dev/null 2>&1; then
    # dockerd-rootless-setuptool.sh ships in docker-ce-rootless-extras, which
    # Ubuntu does not publish, so configure Docker's own repository for it.
    . /etc/os-release
    docker_arch="$(dpkg --print-architecture)"
    if [[ "${ID:-}" != ubuntu || "${VERSION_CODENAME:-}" != noble || "$docker_arch" != amd64 ]]; then
      printf 'Rootless Docker extras require Ubuntu Noble amd64 (found %s %s %s).\n' \
        "${ID:-unknown}" "${VERSION_CODENAME:-unknown}" "$docker_arch" >&2
      exit 1
    fi
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
      "$docker_arch" "$VERSION_CODENAME" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce-rootless-extras
  fi
  if ! command -v dockerd-rootless-setuptool.sh >/dev/null 2>&1; then
    printf 'Rootless mode requires dockerd-rootless-setuptool.sh from docker-ce-rootless-extras.\n' >&2
    exit 1
  fi
fi

if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list \
    -o /etc/apt/sources.list.d/tailscale.list
  apt-get update
  apt-get install -y tailscale
fi
systemctl enable --now tailscaled

if ! command -v mise >/dev/null 2>&1; then
  curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh
fi

if ! id shipwright >/dev/null 2>&1; then
  if [[ "$docker_mode" == rootless ]]; then
    useradd --create-home --home-dir /var/lib/shipwright --shell /usr/sbin/nologin shipwright
  else
    useradd --system --create-home --home-dir /var/lib/shipwright --shell /usr/sbin/nologin shipwright
  fi
fi

if [[ "$docker_mode" == rootful ]]; then
  usermod -aG docker shipwright
else
  remove_docker_group() {
    if id -nG shipwright | tr ' ' '\n' | grep -qx docker; then
      gpasswd -d shipwright docker >/dev/null
    fi
    if id -nG shipwright | tr ' ' '\n' | grep -qx docker; then
      printf 'Rootless mode requires shipwright to be removed from the docker group.\n' >&2
      exit 1
    fi
  }

  # Remove root-equivalent host Docker access before provisioning the
  # per-user daemon so a partial bootstrap cannot leave the account exposed.
  remove_docker_group

  ensure_subid() {
    local database="$1"
    local flag="$2"
    if grep -q '^shipwright:' "$database"; then
      return
    fi
    local range_start
    range_start="$(next_subid_start "$database")"
    usermod "$flag" "$range_start-$((range_start + 65535))" shipwright
  }

  # Hold an exclusive lock across the check-and-allocate sequence so two
  # concurrent bootstraps cannot compute the same free range and overlap; the
  # databases are re-read inside the lock.
  (
    flock 9
    ensure_subid /etc/subuid --add-subuids
    ensure_subid /etc/subgid --add-subgids
  ) 9>/run/shipwright-subid.lock
  loginctl enable-linger shipwright
  shipwright_uid="$(id -u shipwright)"
  systemctl start "user@$shipwright_uid.service"
  runuser -u shipwright -- \
    env HOME=/var/lib/shipwright \
    XDG_RUNTIME_DIR="/run/user/$shipwright_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$shipwright_uid/bus" \
    dockerd-rootless-setuptool.sh install --force
  systemctl --user --machine=shipwright@ enable --now docker.service
  rootless_socket="/run/user/$shipwright_uid/docker.sock"
  for _ in {1..30}; do
    [[ -S "$rootless_socket" ]] && break
    sleep 1
  done
  if [[ ! -S "$rootless_socket" ]]; then
    printf 'Rootless Docker did not create %s.\n' "$rootless_socket" >&2
    exit 1
  fi
fi

install -d -o root -g root -m 755 /opt/shipwright/releases
install -d -o shipwright -g shipwright -m 700 /var/lib/shipwright
install -d -o root -g shipwright -m 750 /etc/shipwright

if [[ ! -f /etc/shipwright/shipwright.env ]]; then
  install -o root -g shipwright -m 640 /dev/null /etc/shipwright/shipwright.env
fi

printf 'Shipwright host bootstrap complete with %s Docker. Configure /etc/shipwright/shipwright.env before deployment.\n' "$docker_mode"
