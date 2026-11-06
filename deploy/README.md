# Deploying agentwallet

One Docker host runs Caddy, which handles automatic HTTPS, in front of `agentwallet serve`. The service is not published on any port of its own. CI builds and pushes `ghcr.io/<owner>/stellar-agent-wallet:<sha>` and deploys it over SSH as the `deploy` user. Nothing is built on the host.

| File | |
|---|---|
| `docker-host.sh` | once, as root: Docker CE + compose, log rotation, ufw (22/80/443), the `deploy` user |
| `bootstrap-host.sh` | once, as root: `/opt/app/agent-wallet/{data,secrets}` owned by uid 65532 (distroless nonroot), plus a new master key |
| `docker-compose.yml`, `Caddyfile` | the stack; SSE (`/api/chat*`) is neither compressed nor buffered |
| `deploy.sh` | copies the compose files, `.env` and `deployments/testnet.json` (as `deployment.json`), pulls the image, runs `agentwallet init` (idempotent: it creates the keystore and funds the relayers on first deploy), starts the stack and checks `https://$DOMAIN/api/config` |

## Secrets
- **Master key**: `/opt/app/agent-wallet/secrets/master.key`. It is generated on the host and never handled by CI. **Back it up to a secret manager.** Without it, `data/keystore.enc` and the sealed agent keys cannot be read.
- **State**: `/opt/app/agent-wallet/data` (SQLite + keystore). Back it up together with the master key.
- **GitHub repository secrets and variables:** the secrets `DEPLOY_SSH_KEY_B64` and `LLM_API_KEY` (optional; the chat is off without it), and the variables `WALLET_HOST`, `WALLET_DOMAIN` and `DEPLOY_SSH_KNOWN_HOSTS`, plus the optional `LLM_BASE_URL` (any OpenAI-compatible API, default OpenRouter), `MODEL` and `APPROVAL_THRESHOLD`. Set `DEPLOY_ENABLED=true` to deploy from `main`.

`TRUST_PROXY=true` makes per-IP rate limits use the client address Caddy sets in `X-Forwarded-For`. Enable it only when the listener is reachable solely through the proxy, as it is here.

## Manual deploy / rollback
```bash
WALLET_SSH=deploy@203.0.113.10 IMAGE_TAG=<sha> DOMAIN=agent-wallet.example.org \
  LLM_API_KEY=… LLM_BASE_URL=https://…/v1 MODEL=… deploy/deploy.sh
```
Or run the `deploy` workflow by hand with an older sha.

`PUBLIC_URL` is `https://$DOMAIN`, and its host is the SEP-10 home and web-auth domain. Changing the domain therefore changes which domain wallets see when they sign in.
