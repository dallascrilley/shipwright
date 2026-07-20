#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'Run bootstrap-host.sh as root.\n' >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y build-essential ca-certificates curl docker.io git python3 rsync
systemctl enable --now docker

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
  useradd --system --create-home --home-dir /var/lib/shipwright --shell /usr/sbin/nologin shipwright
fi
usermod -aG docker shipwright

install -d -o root -g root -m 755 /opt/shipwright/releases
install -d -o shipwright -g shipwright -m 700 /var/lib/shipwright
install -d -o root -g shipwright -m 750 /etc/shipwright

if [[ ! -f /etc/shipwright/shipwright.env ]]; then
  install -o root -g shipwright -m 640 /dev/null /etc/shipwright/shipwright.env
fi

printf 'Shipwright host bootstrap complete. Configure /etc/shipwright/shipwright.env before deployment.\n'
