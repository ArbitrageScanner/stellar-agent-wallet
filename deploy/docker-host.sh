#!/usr/bin/env bash
# One-time preparation of an Ubuntu 24.04 Docker host, run as root:
#   ssh root@host 'bash -s' < deploy/docker-host.sh
# Installs Docker CE + compose from Docker's repository, log rotation, ufw
# (22, 80, 443 only), and a `deploy` user for CI (in the docker group, which
# is root-equivalent: use dedicated hosts). Add CI's public key to
# /home/deploy/.ssh/authorized_keys afterwards.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl ufw unattended-upgrades >/dev/null
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'J'
{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "5" }, "live-restore": true }
J
systemctl enable --now docker >/dev/null 2>&1; systemctl restart docker
# CI deploy user (docker group = root-equivalent on this host; the host is dedicated)
id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash deploy
usermod -aG docker deploy
install -d -o deploy -g deploy -m 700 /home/deploy/.ssh
install -d -o deploy -g deploy -m 750 /opt/app
ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
docker version --format 'docker {{.Server.Version}}'; docker compose version; ufw status
