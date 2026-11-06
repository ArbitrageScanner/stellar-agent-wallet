# agentwallet web UI

The demo UI for the multi-tenant agent wallet. Users sign in with their Stellar wallet (Freighter), get their own OpenZeppelin smart account controlled only by that wallet, add AI agents with a daily USDC limit each, then chat with an agent or connect one over MCP with a per-agent API key. It is plain HTML, CSS and ES modules in `static/`, with no build step, no npm dependencies and no CDN. The Go server embeds `static/` with `go:embed` and serves it at `/`. All API calls use relative URLs (`api/...`), send `credentials: 'same-origin'`, and every non-GET request sends `X-Agentwallet: 1`. The API contract is in [`../docs/API.md`](../docs/API.md).

```
static/
  index.html          views: landing, onboarding, dashboard, chat, how; the "How it works" SVG; the <dialog> modal
  css/app.css         the "device" design system: case, keys, LCD, LEDs, tape; light + dark tokens (prefers-color-scheme + toggle)
  fonts/              self-hosted woff2: Ranade (ITF Free Font License, Fontshare), Doto and Geist Mono (SIL OFL 1.1, Google Fonts), latin subsets
  js/app.js           entry point: config, theme, session lifecycle (401 -> signed out), routing (#dashboard #chat #how)
  js/landing.js       signed-out screen: Connect Freighter / Use test key, readable sign-in errors
  js/signer.js        SEP-10 sign-in and op signing with Freighter or the test key
  js/freighter.js     tiny Freighter client: the extension's window.postMessage protocol (no npm package)
  js/devwallet.js     dev_wallet test key: WebCrypto Ed25519 in sessionStorage, signs the op `hash`
  js/strkey.js        StrKey G.../C... encode/decode (base32 + CRC16-XModem)
  js/ops.js           the op flow modal: prepare -> summary -> sign -> submit -> tx link or error card
  js/onboarding.js    deploy the account, get test USDC, fund the agent wallet
  js/dashboard.js     account card, agents (limit gauge, limit, revoke/restore, API keys), add agent, payments
  js/chat.js          agent picker, SSE chat, tool cards, error cards, approvals, history, agent side panel
  js/data.js          loads me/account/agents/payments, refreshes every 10 s and after txs
  js/widgets.js       status badge, limit gauge, payment rows, API key reveal + MCP snippets
  js/modal.js, js/api.js, js/markdown.js, js/util.js, js/state.js, js/theme-init.js
e2e/
  mock.mjs            dependency-free mock of the whole multi-tenant API, serves ../static
  smoke.mjs           headless-Chromium smoke test (playwright-core)
  run-e2e.sh          npm install (e2e only) + setup-chromium.sh + smoke.mjs
  setup-chromium.sh   local libs/fonts for Chromium in this devcontainer (no root)
```

## Wallets

**Freighter.** `js/freighter.js` talks to the extension the way `@stellar/freighter-api` 6.0.1 does: it posts `{source: "FREIGHTER_EXTERNAL_MSG_REQUEST", messageId, type, ...}` to `window` and waits for `{source: "FREIGHTER_EXTERNAL_MSG_RESPONSE", messagedId}` (the extension's spelling). It implements `isConnected`, `requestAccess`, `getAddress`, `getNetworkDetails`, `signTransaction` and `signAuthEntry`. The UI says so when Freighter is missing (the connection probe times out after 2 s), when it is not on Testnet, or when the user rejects a request (`apiError.code === -4`).

**Test key** (only when `/api/config` has `dev_wallet: true`). "Use test key" makes an Ed25519 key with WebCrypto, keeps it in `sessionStorage` (this tab only), derives the G address with `js/strkey.js`, calls `POST /api/dev/fund`, signs the SEP-10 challenge `hash` and, for every op, submits `{signature: base64}` over the op `hash`. It is labelled TEST KEY everywhere. Never use it for real funds.

## Run the mock

You need Node 20 or newer. The mock has no dependencies.

```bash
node agentwallet/web/e2e/mock.mjs           # http://127.0.0.1:8090
```

| var | effect |
|---|---|
| `PORT=8090` | listen port (`0` picks a random one) |
| `HOST=127.0.0.1` | listen address |
| `DEV_WALLET=0` | turns off `dev_wallet` and `POST /api/dev/fund` (default on) |
| `MOCK_VERIFY=1` | verifies raw `{signature}` submissions as ed25519 over `hash` with the user's G key (default: any signature is accepted) |
| `MOCK_LLM=0` | simulates a missing `LLM_API_KEY` (`llm_configured: false`, no models) |
| `MOCK_SPEED=0.3` | multiplier for all delays |

The mock keeps per-user state in memory: sessions (`aw_session` HttpOnly cookie), the smart account (deployed or not), wallet XLM/USDC, agents with limits and statuses (`pending`, `active`, `revoked`, `expired`), API keys (stored as sha256), payments and conversations. It answers 403 `csrf` to any non-GET `/api/*` request without `X-Agentwallet: 1`, and `GET /api/_mock/stats` counts those rejections. `/mcp` checks the bearer key and then answers 501.

The scripted agent works per agent and matches the suggested prompts:

| message | what streams back |
|---|---|
| "How much money do I have?" / "balance" | `wallet_info` -> text |
| "Pay 1 USDC to G..." | `pay` -> `tool_result` ok -> `tx` -> text |
| "Pay 10 USDC to ..." (over the agent's limit) | `pay` -> `tool_result` error `spending_limit_exceeded` with details |
| "Pay 3 USDC to ..." (above `approval_threshold` 2) | `pay` -> `approval_required` -> (POST approve) -> `approval_resolved` -> `tool_result` -> `tx` |
| any payment by a revoked/expired/pending agent | `tool_result` error `agent_inactive` |
| "Simulate a 2 USDC payment" | `simulate_payment` |
| "Why did the payment fail?" | `payment_history` -> explanation of the last FAILED payment |
| "Show payment history" | `payment_history` -> markdown list |
| "server error" | a fatal `error` event (tests the retry UI) |

## Run the e2e smoke test

```bash
bash agentwallet/web/e2e/run-e2e.sh
```

The script runs `npm install` inside `e2e/` only (`playwright-core@1.56.1`), runs `setup-chromium.sh` once (this devcontainer has no fonts and lacks NSS/X11 libraries, so it unpacks them into `e2e/.pw/` without root), then runs `smoke.mjs`. That starts two mocks on random ports (one with `MOCK_VERIFY=1`, one with `MOCK_LLM=0`) and drives the UI.

What it covers: StrKey vectors (all-zero key -> `GAAA...WHF`, two stellar-sdk pairs, CRC check value, random round trips); the CSRF header; the landing page; "Freighter not installed"; test-key sign-in with a verified ed25519 signature; account deploy; test USDC + funding; add agent with the API key shown once, copy and both MCP snippets; chat (wallet_info, pay 1 -> tx, pay 10 -> limit card, approval reject/approve, stop, history restore); revoke -> `agent_inactive` -> restore; change limit; API key create/revoke (the revoked key gets 401 on `/mcp`); a second agent with valid days and the payments filter; withdraw; light/dark; logout and sign-in again; no horizontal overflow at 390 px on every screen; 0 console errors. A simulated Freighter content script (answering the same postMessages) covers the wrong-network message, sign-in via `signTransaction`, the friendbot notice, a rejected signature with retry, and `signAuthEntry` with the op preimage. Screenshots go to `e2e/shots/` (git-ignored).

Outside this devcontainer, a system Chrome also works. Skip `setup-chromium.sh`, install a browser with `npx playwright-core install chromium-headless-shell`, then run `node e2e/smoke.mjs`.

## Browser storage

`localStorage`: a session hint (`aw.session`: address + signer kind, so a reload tries `/api/me`), the conversation id per agent (`aw.conv.<agent_id>`), the last chat agent (`aw.agent`), the model (`aw.model`) and the theme (`aw.theme`). `sessionStorage`: the test key (`aw.devKey`). The session itself is the server's HttpOnly `aw_session` cookie. Every storage access is wrapped in try/catch.
