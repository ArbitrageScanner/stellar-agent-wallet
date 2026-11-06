#!/usr/bin/env bash
# One-time host preparation, run as root on the Docker host:
#   ssh root@host 'bash -s' < deploy/bootstrap-host.sh
# Creates /opt/app/agent-wallet/{data,secrets} owned by the container user
# (distroless nonroot, uid 65532) and a new master key unless one exists.
# The master key never leaves this host: back it up to your secret manager
# (losing it makes data/keystore.enc and the sealed agent keys unreadable).
set -euo pipefail
DIR=${DIR:-/opt/app/agent-wallet}
install -d -o deploy -g deploy -m 750 "$DIR"
install -d -o 65532 -g 65532 -m 700 "$DIR/data"
install -d -o 65532 -g 65532 -m 700 "$DIR/secrets"
if [ ! -s "$DIR/secrets/master.key" ]; then
  (umask 077; head -c 32 /dev/urandom | base64 > "$DIR/secrets/master.key")
  echo "generated $DIR/secrets/master.key: back it up now"
fi
chown 65532:65532 "$DIR/secrets/master.key"; chmod 400 "$DIR/secrets/master.key"
