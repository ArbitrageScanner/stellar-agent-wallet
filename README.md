# Stellar Agent Wallet

Wallets for autonomous agents on Stellar: each user's budget lives in an [OpenZeppelin smart account](https://docs.openzeppelin.com/stellar-contracts/accounts/smart-account) that only the user's wallet controls, and every agent pays within its own on-chain [spending limit](https://docs.openzeppelin.com/stellar-contracts/accounts/policies).

> ## Live demo: **[agent-wallet.stellar.ascn.ai](https://agent-wallet.stellar.ascn.ai)**
>
> Runs on **Stellar testnet**, so no real money is involved.
>
> 1. Install [Freighter](https://www.freighter.app), create a wallet, switch it to **Testnet** and fund it with friendbot.
> 2. Open the demo and click **Connect Freighter**.
> 3. Create your agent wallet, get 10 test USDC and fund the wallet.
> 4. Add an agent with a daily limit (for example 5 USDC).
> 5. Chat with the agent: "How much money do I have?", "Pay 1 USDC to …", then try more than the limit.
>
> Each step shows its transaction on [stellar.expert](https://stellar.expert/explorer/testnet).

## What it does

- **Sign in with a Stellar wallet** (SEP-10). There are no passwords or service accounts.
- **One smart account per user**, deployed at a deterministic address. Its owner rule is `Delegated(user's G address)`, so only the user's wallet can move funds, change limits or manage agents. The service never holds the owner key.
- **Many agents per user.** Each agent is a context rule `CallContract(USDC)` with its own ed25519 key, a rolling spending limit (for example 5 USDC per ~24h) and an optional expiry. Revoking, restoring an agent or changing its limit takes one wallet signature.
- **Agents pay over MCP or from the built-in chat.** An external agent connects to `/mcp` with a per-agent API key. The chat works with any tool-calling model behind an OpenAI-compatible API.
- **Rejections are real.** An over-limit payment fails inside the smart account's `__check_auth` with `SpendingLimitExceeded` (`#3221`), and the agent gets a structured error it can explain.

```
 user wallet (G…) ──owns (Delegated, rule #0)──► smart account (C…)  ◄── USDC from the user's wallet
                                                  ├─ rule #1  agent "shopper"   5 USDC/day
                                                  └─ rule #2  agent "research" 20 USDC/day, 30 days
 agent ─MCP / chat─► agentwallet ─signs with the agent key─► Stellar RPC
                                   __check_auth → rule → ed25519 verifier → spending-limit policy
```

## Repository layout

| Path | |
|---|---|
| [`contracts/`](contracts) | the OpenZeppelin smart account, ed25519 verifier and spending-limit policy (`stellar-accounts` 0.8.0, taken from OZ's multisig example) |
| [`agentwallet/`](agentwallet) | the Go service: wallet sign-in, accounts and agents, MCP server, chat agent, embedded web UI. See its [README](agentwallet/README.md) and [API](agentwallet/docs/API.md). |
| [`scripts/`](scripts) | the single-wallet testnet scenario: deploy, top up, pay, add the limit, get rejected. The last run's transactions are in [`scripts/TRANSACTIONS.md`](scripts/TRANSACTIONS.md). |
| [`deployments/`](deployments) | addresses of the shared testnet contracts (verifier, policy, USDC) that the service reads |
| [`deploy/`](deploy) | Docker Compose + Caddy deployment to one host, driven by CI |

## Quick start (local)

Requirements: Rust with the `wasm32v1-none` target and [stellar-cli](https://github.com/stellar/stellar-cli) v30 or newer, Node 20+, Go 1.27+.

```bash
npm install && npm run build      # build the contracts
npm run demo                      # deploy the shared contracts on testnet -> deployments/testnet.json

cd agentwallet
go run ./cmd/agentwallet init     # prints a new MASTER_KEY (store it), creates the sealed keystore, funds relayers
export MASTER_KEY=…               # or MASTER_KEY_FILE=/run/secrets/…
export LLM_API_KEY=… LLM_BASE_URL=https://…/v1 MODEL=…   # optional: enables the chat
go run ./cmd/agentwallet serve    # http://localhost:8090
```

The shared contracts listed in [`deployments/testnet.json`](deployments/testnet.json) are already deployed on testnet, so you can skip `npm run demo` and use them.

## The single-wallet scenario

[`scripts/demo.mjs`](scripts/demo.mjs) shows the whole mechanism with one wallet and one agent:

1. **Deploy** the verifier, the policy and a smart account. Rule `#0` is the user's key; rule `#1` is `CallContract(USDC)` for the agent key.
2. **Top up.** The user gets 10 Circle testnet USDC and sends it to the smart account.
3. **Pay.** The agent pays 1 USDC under rule `#1`: success.
4. **Limit.** The owner installs a 5 USDC/day spending limit. A 10 USDC payment is rejected on-chain with `#3221`, while a 2 USDC payment still goes through.

Every transaction of the last run, with the on-chain rejection error, is listed in [scripts/TRANSACTIONS.md](scripts/TRANSACTIONS.md).

A few details:
- **Signing.** The OZ account takes no plain Stellar signature. The agent signs `sha256(xdr(AuthDigestPreimage{account, context_rule_ids, signature_payload}))`, and the signature goes into `AuthPayload{context_rule_ids, signers}`.
- **Test USDC.** [faucet.circle.com](https://faucet.circle.com) is behind a CAPTCHA, so the script buys the same Circle testnet USDC (`GBBD…LFA5`) for XLM on the testnet DEX.
- **On-chain rejection.** To give the rejection a transaction hash, the script submits the over-limit payment with the footprint of a passing probe call. On-chain, the SAC checks authorization before the balance, so the error comes from the policy.

## Security

- **Owner key:** only in the user's wallet.
- **Agent keys:** sealed with AES-256-GCM under a master key that comes only from the environment or a mounted secret file.
- **Sessions and API keys:** stored only as SHA-256 hashes.
- **On-chain limits:** even with a leaked agent key, an agent can only call USDC, within its limit and expiry.

The full model is in [agentwallet/README.md](agentwallet/README.md#security-model). This is testnet software and has not been audited for mainnet use.

## License

MIT, see [LICENSE](LICENSE). The web UI fonts have their own licenses ([fonts/LICENSE.md](agentwallet/web/static/fonts/LICENSE.md)). The contracts are derived from [OpenZeppelin/stellar-contracts](https://github.com/OpenZeppelin/stellar-contracts) (MIT).
