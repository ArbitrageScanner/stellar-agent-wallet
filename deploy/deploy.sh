#!/usr/bin/env bash
# Deploys agentwallet + Caddy over SSH to a Docker host prepared with
# bootstrap-host.sh. Images are pulled, nothing is built on the host. The
# keystore is created on first deploy (`agentwallet init`, idempotent).
#
#   WALLET_SSH=deploy@203.0.113.10 IMAGE_TAG=<git sha> DOMAIN=agent-wallet.example.org \
#   LLM_API_KEY=… LLM_BASE_URL=https://…/v1 MODEL=… deploy/deploy.sh
#
# Optional: IMAGE_PREFIX (default ghcr.io/arbitragescanner), REGISTRY_USER +
# REGISTRY_TOKEN (this pull only, not stored), LLM_API_KEY (or OPENROUTER_API_KEY),
# LLM_BASE_URL (OpenAI-compatible, default OpenRouter), MODEL, APPROVAL_THRESHOLD,
# RELAYERS, RPC_URL, WALLET_DIR, PULL=0, SSH_OPTS.
set -euo pipefail

: "${WALLET_SSH:?}" "${IMAGE_TAG:?}" "${DOMAIN:?}"
PREFIX=${IMAGE_PREFIX:-ghcr.io/arbitragescanner}
DIR=${WALLET_DIR:-/opt/app/agent-wallet}
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC2086
remote() { ssh ${SSH_OPTS:-} -o BatchMode=yes "$WALLET_SSH" "$@"; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
umask 077
cp "$HERE/docker-compose.yml" "$HERE/Caddyfile" "$work/"
cp "$HERE/../deployments/testnet.json" "$work/deployment.json"   # shared testnet contracts
chmod 644 "$work/deployment.json"                                 # read by uid 65532
cat > "$work/.env" <<EOF
COMPOSE_PROJECT_NAME=agent-wallet
AGENTWALLET_IMAGE=$PREFIX/stellar-agent-wallet:$IMAGE_TAG
DOMAIN=$DOMAIN
LLM_API_KEY=${LLM_API_KEY:-${OPENROUTER_API_KEY:-}}
LLM_BASE_URL=${LLM_BASE_URL:-https://openrouter.ai/api/v1}
MODEL=${MODEL:-openai/gpt-4o-mini}
APPROVAL_THRESHOLD=${APPROVAL_THRESHOLD:-2}
RELAYERS=${RELAYERS:-3}
RPC_URL=${RPC_URL:-https://soroban-testnet.stellar.org}
EOF

remote "test -d '$DIR/data' -a -d '$DIR/secrets'" ||
  { echo "run deploy/bootstrap-host.sh on the host first" >&2; exit 1; }
tar -C "$work" -czf - . | remote "tar -xzf - -C '$DIR' --no-same-owner"

printf '%s\n%s\n' "${REGISTRY_USER:-}" "${REGISTRY_TOKEN:-}" | remote "set -e; cd '$DIR'
  read -r user; read -r token
  export DOCKER_CONFIG=\$(mktemp -d); trap 'rm -rf \"\$DOCKER_CONFIG\"' EXIT
  [ -z \"\$token\" ] || printf '%s' \"\$token\" | docker login ghcr.io -u \"\$user\" --password-stdin >/dev/null
  [ '${PULL:-1}' = 0 ] || docker compose pull --quiet
  docker compose run --rm --no-deps agentwallet init
  docker compose up -d --no-build --remove-orphans --quiet-pull
  docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
  docker image prune -f >/dev/null"

# The image is distroless (no shell for a healthcheck): check from outside.
for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "https://$DOMAIN/api/config"; then echo "https://$DOMAIN is up"; exit 0; fi
  sleep 4
done
echo "https://$DOMAIN/api/config did not answer" >&2
remote "cd '$DIR' && docker compose logs --tail=50"
exit 1
