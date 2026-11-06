# agentwallet HTTP API (multi-tenant)

`agentwallet serve` listens on `:8090`. It serves the UI at `/`, the JSON API at `/api/*` and MCP at `/mcp`.

## Model

- **User:** a Stellar G account that signs in with its wallet (SEP-10).
- **Account:** the user's own OpenZeppelin smart account, one per user. Its address is derived deterministically from the user's G address. Rule #0 is `Delegated(user G)`, so only the user's wallet controls it. The service never holds the owner key.
- **Agent:** a context rule `CallContract(USDC)` on the user's account. Each agent has its own ed25519 key, which the service generates and stores encrypted, and usually a spending-limit policy (amount per period). An agent can pay only USDC, within its limit.
- **API key:** a bearer token an external agent uses on `/mcp`. It is shown once, and the server stores only its hash.

## Conventions

- Amounts are decimal strings, e.g. `"1.5"` USDC.
- `url` fields point at `https://stellar.expert/explorer/testnet/...`.
- Errors: `{"error": {"code", "message", "details?"}}` with a 4xx or 5xx status.
- The session is an HttpOnly cookie, `aw_session`.
- Every non-GET `/api/*` request must send the header `X-Agentwallet: 1` (CSRF guard). Without it the response is 403.
- Endpoints marked 🔒 need a session; without one they return 401 `unauthorized`.

## Signing operations (the "op" pattern)

Anything the user's wallet must sign is done in two steps:

1. A `…/prepare` endpoint returns an **op**:
   ```json
   { "op_id": "…", "kind": "auth" | "tx", "summary": "Add agent \"Shopping bot\" (5 USDC / day)",
     "preimage": "base64 HashIdPreimage",   // kind=auth: pass to Freighter signAuthEntry(preimage, {networkPassphrase, address})
     "xdr": "base64 TransactionEnvelope",   // kind=tx:   pass to Freighter signTransaction(xdr, {networkPassphrase, address})
     "hash": "hex",                         // the 32 bytes an ed25519 key signs (sha256(preimage) for auth, tx hash for tx)
     "network_passphrase": "Test SDF Network ; September 2015",
     "expires_at": "RFC3339" }
   ```
2. `POST /api/ops/{op_id}/submit` 🔒 takes exactly one of these:
   - `{"signed_auth_entry": "base64"}`: what Freighter `signAuthEntry` returns (base64 signature).
   - `{"signed_xdr": "base64"}`: what Freighter `signTransaction` returns.
   - `{"signature": "base64"}`: a raw ed25519 signature over `hash`. The dev wallet uses this, and it works for either kind.

   The response is `{ "ok": true, "tx": {hash, url, status}, "result": {...} }`. On failure it is `{ "ok": false, "tx": {…} | null, "error": {...} }` with HTTP 200 when the failure is on-chain or in simulation.

Ops expire after about 10 minutes, and only the user who prepared an op can submit it.

## Auth

| | |
|---|---|
| `POST /api/auth/challenge` `{address}` | Returns a SEP-10 challenge as an op of `kind: "tx"`: `{op_id, xdr, hash, network_passphrase, expires_at}`. |
| `POST /api/auth/login` `{op_id, signed_xdr? , signature?}` | Verifies the SEP-10 challenge and sets the `aw_session` cookie. Returns `{address}`. |
| `POST /api/auth/logout` | Clears the session. |
| `GET /api/me` 🔒 | `{address, account, account_deployed, wallet: {xlm, usdc, usdc_trustline}, account_url}` |

## Config

`GET /api/config`:
```json
{ "network": "testnet", "network_passphrase": "…", "explorer": "…", "usdc_contract": "C…",
  "default_model": "…", "llm_configured": true, "approval_threshold": "2",
  "dev_wallet": false, "demo_payee": "G…", "period_ledgers": 17280, "ledger_seconds": 5 }
```
- `dev_wallet: true` only when the server runs with `DEV_WALLET=true`, for tests. The UI may then offer an in-browser test key: a raw ed25519 key that signs `hash` and is funded by friendbot through `POST /api/dev/fund {address}`.

## Account 🔒

| | |
|---|---|
| `POST /api/account` | Deploys the user's smart account if it is missing (the relayer pays; no signature needed). Returns `{account, tx | null}`. |
| `GET /api/account` | `{address, url, balances:[{asset, amount}], latest_ledger, rules:[…], agents:[Agent]}` |
| `POST /api/account/test-usdc/prepare` `{amount}` | An op of kind `tx`: a USDC trustline (if missing) plus buying `amount` USDC for XLM on the testnet DEX, into the user's G wallet. |
| `POST /api/account/fund/prepare` `{amount}` | An op of kind `tx`: USDC from the user's G wallet to the account. |
| `POST /api/account/withdraw/prepare` `{amount}` | An op of kind `auth`: USDC from the account back to the user's G wallet. |

## Agents 🔒

`Agent`:
```json
{ "id": "ag_…", "name": "Shopping bot", "public_key": "G…", "rule_id": 1,
  "status": "pending" | "active" | "revoked" | "expired",
  "valid_until": 5600000 | null, "created_at": "…",
  "limit": { "installed": true, "limit": "5", "spent": "1", "remaining": "4", "period_ledgers": 17280, "resets_in_seconds": 51000 | null },
  "api_keys": [{ "prefix": "awk_3f9a", "created_at": "…", "last_used_at": "…" | null }],
  "payments_count": 3 }
```

| | |
|---|---|
| `GET /api/agents` | `{items: [Agent]}` |
| `POST /api/agents/prepare` `{name, daily_limit, valid_days?}` | Creates a pending agent (a fresh key, stored encrypted) and returns an op of kind `auth` (`add_context_rule`). Submitting it activates the agent; the submit `result` is `{agent: Agent, api_key: "awk_…"}`. This is the only time the API key is shown. |
| `POST /api/agents/{id}/limit/prepare` `{daily_limit}` | An op of kind `auth`. |
| `POST /api/agents/{id}/revoke/prepare` | An op of kind `auth`: sets `valid_until` to a ledger a few seconds ahead. |
| `POST /api/agents/{id}/restore/prepare` | An op of kind `auth`: sets `valid_until` to none. |
| `POST /api/agents/{id}/keys` | Creates another API key: `{api_key, prefix}`, shown once. Off-chain, so no signature is needed. |
| `DELETE /api/agents/{id}/keys/{prefix}` | Revokes an API key. |

## Payments 🔒

`GET /api/payments?agent={id}&limit=20` returns the payments made by the user's agents, newest first:
```json
{ "items": [{ "hash", "url", "agent_id", "agent_name", "to", "amount", "asset": "USDC", "status": "SUCCESS" | "FAILED",
              "error": {code, message, details} | null, "ledger", "created_at", "source": "chat" | "mcp" }] }
```

## Chat 🔒

`POST /api/chat` `{agent_id, conversation_id?, message, model?}` returns `text/event-stream`. The events are the same as before:

| event | data |
|---|---|
| `conversation` | `{id}` (always first) |
| `text_delta` | `{text}` |
| `tool_call` | `{id, name, arguments}` |
| `tool_result` | `{id, name, ok, result, error}` |
| `tx` | `{hash, url, status}` |
| `approval_required` | `{approval_id, tool_call_id, summary, to, amount, asset}` |
| `approval_resolved` | `{approval_id, approved}` |
| `error` | `{message}` |
| `done` | `{}` |

- `POST /api/chat/{conversation_id}/approvals/{approval_id}` `{approve}` → `{ok}`.
- `GET /api/conversations/{id}` → `{id, agent_id, messages:[…]}`. Conversations are private to their user.
- `GET /api/models` → `{default, items:[{id, name, context_length}]}`.

The tools and their result shapes are the same as in the single-wallet version: `wallet_info`, `simulate_payment`, `pay` and `payment_history`, all scoped to the selected agent.

## MCP

`/mcp` (Streamable HTTP) needs `Authorization: Bearer awk_…`. The key decides which agent the tools act for.

## Error codes

| HTTP | code | when |
|---|---|---|
| 400 | `invalid_argument` | bad body or amount, a name longer than 40 characters, `valid_days` outside 1–365, amount above the demo cap |
| 400 | `account_unfunded` | test-USDC prepare while the user's G account has no XLM (fund it with friendbot) |
| 401 | `unauthorized` / `signature_invalid` | no or expired session; a bad sign-in signature |
| 403 | `csrf` | non-GET `/api/*` without `X-Agentwallet: 1` |
| 404 | `not_found` | an unknown agent, op, conversation or key, or one that belongs to another user |
| 409 | `account_missing` | an account endpoint before `POST /api/account` |
| 429 | `rate_limited` | sign-in, deploy, chat or friendbot rate limits |
| 502 | `rpc_error` | Stellar RPC failures |

Wallet and contract errors inside op results and tool results use the codes listed under Tools: `spending_limit_exceeded`, `insufficient_balance`, `agent_inactive`, `payee_no_trustline`, `signature_invalid`, `tx_failed` and so on.

The op `result` is `{agent, api_key}` for add-agent and `{agent}` for limit, revoke and restore. For the other ops it is null.

A pending agent, whose add op was not signed, is deleted when the op fails or expires (~10 minutes).
