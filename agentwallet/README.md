# agentwallet

A multi-tenant service that lets many AI agents spend on behalf of many users. Each user's budget sits in a wallet that only that user controls, and on-chain limits cap what each agent can spend.

**Live demo (testnet): [agent-wallet.stellar.ascn.ai](https://agent-wallet.stellar.ascn.ai)**

- **Sign in with your Stellar wallet.** Freighter signs a SEP-10 challenge, so there are no passwords or accounts to create.
- **Your own smart account.** The service deploys an [OpenZeppelin smart account](https://docs.openzeppelin.com/stellar-contracts/accounts/smart-account) for you at a deterministic address. Its owner rule #0 is `Delegated(your G address)`, so only your wallet can move funds, change limits or manage agents. **The service never holds the owner key.**
- **Many agents per user.** Each agent is a context rule `CallContract(USDC)` on your account. It has its own ed25519 key and a [spending-limit policy](https://docs.openzeppelin.com/stellar-contracts/accounts/policies) (for example 5 USDC per ~24h), and optionally an expiry. You can revoke or restore an agent, or change its limit, with one wallet signature.
- **Agents pay through MCP or the built-in chat.** An external agent connects to `/mcp` with its own API key. The chat UI talks to any model with tool calling behind an OpenAI-compatible API ([OpenRouter](https://openrouter.ai) by default, or your own gateway via `LLM_BASE_URL`). Both use the same tools: `wallet_info`, `simulate_payment`, `pay` and `payment_history`.

```
 Freighter (user G…) ──owns (Delegated, rule #0)──► user's smart account C…  ◄── USDC from the user's wallet
                                                     ├─ rule #1: agent "shopper"   5 USDC/day
                                                     ├─ rule #2: agent "research" 20 USDC/day, valid 30 days
                                                     └─ …
 agent (MCP, API key) ─► agentwallet ─ signs AuthDigest with the agent key ─► relayer pool ─► Stellar RPC
                                                         __check_auth → rule → ed25519 verifier → spending-limit policy
```

The single-wallet version of the same mechanism, with every transaction linked, is described in the [repository README](../README.md#the-single-wallet-scenario).

## Security model

| Secret | Where it lives | If it leaks |
|---|---|---|
| **Owner key** (the user's wallet) | Only in the user's wallet. The service gets signatures (`signAuthEntry` / `signTransaction`) for operations it has prepared and that the user confirmed. | n/a: the service never sees it |
| **Agent keys** | In the DB, sealed with AES-256-GCM under the master key. The AAD is `agent:<id>`, so a ciphertext can't be swapped between rows. Decrypted only into memory. | Bounded on-chain: the agent's rule can only call USDC within its limit and expiry, and the owner can revoke it. |
| **Relayer pool and SEP-10 key** | `data/keystore.enc`, sealed under the master key. Created by `agentwallet init`. | Relayers only pay fees (testnet XLM), and the SEP-10 key only signs challenges. |
| **Master key** | `MASTER_KEY` or `MASTER_KEY_FILE` (a mounted secret). Never written by the service. | The sealed files become readable. Put it in a secret manager or KMS. |
| **Sessions and API keys** | Only `SHA-256(token)` is stored. The session is an `HttpOnly; SameSite=Strict` cookie (`Secure` over https). An API key is shown once. | A DB dump gives no usable tokens. |

Other protections:
- **CSRF:** every state-changing `/api` call needs the `X-Agentwallet: 1` header. CORS is never enabled, so other sites can't send it.
- **Headers:** a strict CSP, no framing, `nosniff`.
- **Signing is two-phase and bound to the user.** The server prepares the exact transaction or auth preimage. It accepts only a signature that verifies against that preimage and the signed-in user's key, and each op is single use with a ~10 minute expiry.
- **Revoking is immediate at the service level.** The agent's API keys stop working at once. On-chain, `valid_until` expires the rule within ~2 minutes as a hard stop, even against a compromised service.
- **Payments above `APPROVAL_THRESHOLD`** need a human approve click in the chat, or MCP elicitation.
- **Abuse limits**, all configurable (see [.env.example](.env.example)):
  - chat: 50 messages per wallet per day and 150 per IP, at most 4000 characters per message;
  - model: a service-wide daily budget of model calls, `max_tokens` per reply, and only the latest 30 messages sent per turn;
  - concurrency: at most 3 chats answering at once per wallet;
  - tools: per-agent rate limits on tool calls and payments;
  - operations: limits on wallet operations, unsigned ops, new agent wallets per IP, agents per wallet and API keys per agent.

  Daily counters live in the database, so a restart does not reset them.
- **Each user sees only their own** account, agents, conversations and payments. The testnet test checks this.

- **Account addresses are recorded** at first sign-in and never re-derived, so rotating the keystore (and with it the deploying relayer) does not move existing users to new accounts.

**Back up the master key together with `data/`:** without it the keystore and the agent keys cannot be decrypted. Not covered yet: KMS-backed sealing (the vault is a small interface you can replace), and keeping agent keys outside the service altogether, where the agent holds its own key.

## Quick start (testnet)

Requirements: Go 1.27+. You also need the shared contracts from the parent repo: `npm run demo` there writes `../deployments/testnet.json` with the verifier, policy and USDC addresses. The account wasm is already uploaded on testnet.

```bash
cd agentwallet
go run ./cmd/agentwallet init          # prints a new MASTER_KEY (store it!), creates data/keystore.enc, funds 3 relayers
export MASTER_KEY=…                    # or MASTER_KEY_FILE=/run/secrets/…
export LLM_API_KEY=…                   # optional: enables the chat
export LLM_BASE_URL=https://…/v1 MODEL=…   # any OpenAI-compatible API (default: OpenRouter)
go run ./cmd/agentwallet serve         # http://localhost:8090
```

Open http://localhost:8090 and use Freighter set to **Testnet**:
1. **Sign in.** Freighter signs the SEP-10 challenge.
2. **Create the agent wallet** (the relayer pays for the deploy).
3. **Get test USDC.** One transaction adds a trustline and buys USDC on the testnet DEX. You can use https://faucet.circle.com instead.
4. **Fund** the agent wallet.
5. **Add an agent** with a daily limit. You sign once, and you get the agent's API key **once**.
6. **Chat with the agent, or connect your own.** Any MCP client that speaks Streamable HTTP can use the agent's API key:
   ```bash
   claude mcp add --transport http shopper http://localhost:8090/mcp --header "Authorization: Bearer awk_…"
   # or over stdio, on the server host:
   AGENTWALLET_API_KEY=awk_… agentwallet mcp
   ```
   [examples/mcp-client](examples/mcp-client/main.go) is a minimal Go client.

The chat needs a model with tool calling behind an OpenAI-compatible chat completions API: set `LLM_API_KEY`, `LLM_BASE_URL` (ending in `/v1`) and `MODEL`. The older `OPENROUTER_API_KEY` / `OPENROUTER_URL` names still work. All settings are in [.env.example](.env.example).

For automated tests, `DEV_WALLET=true` lets the UI use an in-browser test key (funded by friendbot) instead of Freighter. Never enable it in production.

### Docker

```bash
docker build -t agentwallet ./agentwallet
docker run --rm -p 8090:8090 --user "$(id -u)" \
  -v "$PWD/agentwallet/data:/data" \
  -v "$PWD/deployments/testnet.json:/config/deployment.json:ro" \
  -v /path/to/master.key:/run/secrets/agentwallet_master_key:ro \
  -e LLM_API_KEY -e LLM_BASE_URL -e MODEL agentwallet
```

## API

The HTTP contract is in [docs/API.md](docs/API.md): sign-in, account, agents, the op pattern for wallet signatures, payments, chat SSE and MCP. The wallet logic is in [internal/wallet](internal/wallet):
- `tenant.go`: deterministic accounts, `Delegated` owner calls, user-signed transactions;
- `wallet.go`: OZ `AuthDigest` signing for agents, simulation, the relayer pool, error classification.

Relayers are a pool of channel accounts, so payments of different agents go out in parallel, each with its own sequence number.

## Tests

```bash
go test ./...                     # unit: vault, hashed tokens, amounts/XDR, agent loop vs a mock model API
bash web/e2e/run-e2e.sh           # UI smoke test in headless Chromium against the JS mock API
(cd web/e2e && node real-stack.mjs)   # the UI against a running DEV_WALLET=true server (real model, or mock-llm.mjs)

# end to end on testnet over the HTTP API: two users, real transactions (~6 min)
MASTER_KEY_FILE=… KEYSTORE_FILE=$PWD/data/keystore.enc DEPLOYMENT_FILE=$PWD/../deployments/testnet.json \
  go test -tags testnet -run TestTestnet -v -timeout 20m ./internal/server
```

### Testnet run (2026-11-06)

This is from `TestTestnet`. A user signs in through SEP-10, and every wallet signature is a raw ed25519 signature over the op hash, which is what Freighter's `signAuthEntry` and `signTransaction` produce:

| step | tx |
|---|---|
| deploy the user's smart account (`Delegated` owner) | [2581b2ba…](https://stellar.expert/explorer/testnet/tx/2581b2bae0f9c298194e7530deee4d4c49fa5ff1e8d352ee7bcd188a15d93212) |
| user: trustline + buy 10 test USDC | [5190eb01…](https://stellar.expert/explorer/testnet/tx/5190eb014c3029bbfa6899e67683913f85c6b0e920381f8133a83fd29d0013ac) |
| user funds the agent wallet with 10 USDC | [70faa653…](https://stellar.expert/explorer/testnet/tx/70faa65365d087e1dddc7557e189c2355e04ff413fff575cf88cbfce61e8d642) |
| owner adds agent "shopper", 5 USDC/day (wallet signature) | [a427c93f…](https://stellar.expert/explorer/testnet/tx/a427c93f3516e8b51e0e0b88fd6cd38ff17557ced4d0290e628a1262fdb3e5ae) |
| agent pays 1 USDC, from the chat | [fbb0f454…](https://stellar.expert/explorer/testnet/tx/fbb0f4540e50c4160b987e3928fdeb2daee56643f33f034d7c7ee3d500527d11) |
| agent pays 1 USDC, over MCP with its API key | [a07dc9c0…](https://stellar.expert/explorer/testnet/tx/a07dc9c0318ce9c15092f8b65cd573e74cbdd5ba3095b50050edd9be991c0b08) |
| agent pays 4 USDC over MCP: ❌ `spending_limit_exceeded` (2 of 5 spent) | rejected |
| owner revokes the agent; MCP refuses it | [23457700…](https://stellar.expert/explorer/testnet/tx/234577004a9a5e4701acc68fed821b794ca10a0f3f13a20f2ba4fd93f2902bac) |
| owner restores the agent | [86f0b409…](https://stellar.expert/explorer/testnet/tx/86f0b4091522925aeb888f30386ec25a5faa4da58c6976c454ba6ad9ad3a6239) |
| owner raises the limit to 10 USDC/day | [568d3a3e…](https://stellar.expert/explorer/testnet/tx/568d3a3eaab2bad51fa17e8f3811f4161ada59af8b7438a0040470d639a32c17) |
| owner withdraws 2 USDC back to their wallet | [e8afbe5f…](https://stellar.expert/explorer/testnet/tx/e8afbe5fa8d7f2513acf1f6012d161759689f5fec1b599d79ffdd636970b5be0) |

A second user then signed in and could not see or manage the first user's agent.

The browser UI was also run against the real server with `web/e2e/real-stack.mjs`, using a test key in place of Freighter, both with the scripted model and with a real tool-calling model. It produced these transactions, among others: [agent added](https://stellar.expert/explorer/testnet/tx/9218f405b10e855ed2ce34edc8e7ef53792e2c2ad7b6ac2a91e65a2de6d55a53), [chat payment of 1 USDC](https://stellar.expert/explorer/testnet/tx/40748c819dfc68561ed33dddc71f912e24efedaadf0fe7ab5026920c7fdb2e45), [6 USDC rejected by the limit](https://stellar.expert/explorer/testnet/tx/2bc4b9bbd70fabc7e89d1a140be1adaec25e3151378c831711cecf3d0725fa91), [3 USDC after an approve click](https://stellar.expert/explorer/testnet/tx/e5d8d9135624d38d67897a318c43b7db7c1b785dd07882e37a1d715db54a641b) and [withdraw](https://stellar.expert/explorer/testnet/tx/aa8f8a00f0817e97c0cd13395a23ef5950a57e2a0dbfb28277504037377d5c95).

## Limits

- Testnet only, not audited. Only USDC is wired in, and only Freighter, which supports `signAuthEntry`.
- Conversations and pending ops live in memory and are lost on restart. Users, agents and payments persist in SQLite.
- The relayer pays all fees; a later step is OZ fee abstraction (fees in USDC).
- On a slow RPC, each payment takes 10–30 s.
