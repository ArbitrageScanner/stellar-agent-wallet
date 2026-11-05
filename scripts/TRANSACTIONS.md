# Testnet run (2026-11-05T13:24:49.150Z)

All transactions below were produced by one `npm run demo` run on Stellar testnet.

## Accounts and contracts

| Role | Address |
|---|---|
| Agent wallet (OZ smart account) | [`CDB4MZ72JM3KA35WHGWD33KA3HH5GSU6RGAO3RS2M7EAADPPCSOG75II`](https://stellar.expert/explorer/testnet/contract/CDB4MZ72JM3KA35WHGWD33KA3HH5GSU6RGAO3RS2M7EAADPPCSOG75II) |
| Ed25519 verifier | [`CACX7VUUKW6MUJ5FCNHZRTK7ZXAAQ6RSHRGX24HNVNMX2TXMUKS4POZ7`](https://stellar.expert/explorer/testnet/contract/CACX7VUUKW6MUJ5FCNHZRTK7ZXAAQ6RSHRGX24HNVNMX2TXMUKS4POZ7) |
| Spending-limit policy | [`CBTDPBAOKKRC4UYNQOHNKT63NL76RMD6W2HRQTMUIEGA6NLUQJVP4YJP`](https://stellar.expert/explorer/testnet/contract/CBTDPBAOKKRC4UYNQOHNKT63NL76RMD6W2HRQTMUIEGA6NLUQJVP4YJP) |
| USDC (Circle testnet, SAC) | [`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`](https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) |
| relayer | [`GAXRVEG7WT4IXM7W22CQPAU3EJEYTPHSYCVNNCM4TIKA4IQGC24RNSRS`](https://stellar.expert/explorer/testnet/account/GAXRVEG7WT4IXM7W22CQPAU3EJEYTPHSYCVNNCM4TIKA4IQGC24RNSRS) |
| user | [`GDRCJNZV2JNF2E4ZDOP2HH2UT3NR3VCB7D6YCAVYXPGUSWQS52MYLSSO`](https://stellar.expert/explorer/testnet/account/GDRCJNZV2JNF2E4ZDOP2HH2UT3NR3VCB7D6YCAVYXPGUSWQS52MYLSSO) |
| agent | [`GA3B46QBK6XCI6JRXGUSOKG5GGMMKID2HU4SOGNREIKKE5B2PCU36IET`](https://stellar.expert/explorer/testnet/account/GA3B46QBK6XCI6JRXGUSOKG5GGMMKID2HU4SOGNREIKKE5B2PCU36IET) |
| payee | [`GB3WNAVXMVP6TDJ6CN3TVD5GO5LDZA52U7G44X76UQR7JAKXE6DAEBN6`](https://stellar.expert/explorer/testnet/account/GB3WNAVXMVP6TDJ6CN3TVD5GO5LDZA52U7G44X76UQR7JAKXE6DAEBN6) |

## Transactions

| # | Step | Result | Tx |
|---|---|---|---|
| 1 | upload ed25519 verifier wasm | SUCCESS | [56b033215b33…](https://stellar.expert/explorer/testnet/tx/56b033215b338af131c608504de0431b3c3ca206038759b73f084a296ac922c7) |
| 2 | upload spending-limit policy wasm | SUCCESS | [8553786bcfc7…](https://stellar.expert/explorer/testnet/tx/8553786bcfc72ff0a363b43169d2ca8e6ad35ca73033d1e9d44356a7c5d19244) |
| 3 | upload smart account wasm | SUCCESS | [7876eb0b4ab2…](https://stellar.expert/explorer/testnet/tx/7876eb0b4ab2fbe634a8760ca0c5f03b99396a34e66f40cccbf78abaf8212304) |
| 4 | deploy ed25519 verifier | SUCCESS | [39eacb0ac689…](https://stellar.expert/explorer/testnet/tx/39eacb0ac6891b1b0b42782639635f4ef91ebec547a8484e970caa1b4bb3538a) |
| 5 | deploy spending-limit policy | SUCCESS | [24c650f5b36f…](https://stellar.expert/explorer/testnet/tx/24c650f5b36fac7b656d58f363c236a72e2a1855ff7cbe0ec0360f4c17c7bd33) |
| 6 | deploy smart account (owner = user's ed25519 key, rule #0 Default) | SUCCESS | [0557e5786fe2…](https://stellar.expert/explorer/testnet/tx/0557e5786fe2f7850011a8b209ed299fe0192cbdeb036a3f3d2d78f68df6f07a) |
| 7 | owner adds context rule #1: CallContract(USDC) signed by the agent key | SUCCESS | [4d6aeb87510f…](https://stellar.expert/explorer/testnet/tx/4d6aeb87510fda137e858c5e905efa6efa29b06a04e8ed01975f9109ad9ed0b9) |
| 8 | payee: trustline to USDC | SUCCESS | [44bab139e3d7…](https://stellar.expert/explorer/testnet/tx/44bab139e3d7f078ca0b6569634d3daa928df7969b8ea32934dcf57b0ad27676) |
| 9 | user: trustline + buy 10 Circle testnet USDC for XLM on the testnet DEX | SUCCESS | [6bacc6ed6eba…](https://stellar.expert/explorer/testnet/tx/6bacc6ed6eba06c9d3815ff11cc7b6e55294a5d2c0e2f1c465f60ecd10392b96) |
| 10 | user tops up agent wallet with 10 USDC | SUCCESS | [9dd3034fc8ae…](https://stellar.expert/explorer/testnet/tx/9dd3034fc8ae72ba7c75ebb7080a0ce68611ba48ca6109f8a72ab8f9192124c0) |
| 11 | agent pays 1 USDC to payee | SUCCESS | [1835b7027e4f…](https://stellar.expert/explorer/testnet/tx/1835b7027e4f40fe9b0e02629e1a5275d1ae7e39d34bb3b88e6b80ab718825a3) |
| 12 | owner adds spending-limit policy (5 USDC / 17280 ledgers) to rule #1 | SUCCESS | [eea6dc3a9bfb…](https://stellar.expert/explorer/testnet/tx/eea6dc3a9bfb0fa3734ff463cb14332df44e9bc4331ad8cee6fe95a7a4565a12) |
| 13 | agent tries to pay 10 USDC (must be rejected) | FAILED | [1c3662a09e4f…](https://stellar.expert/explorer/testnet/tx/1c3662a09e4fcac303cf0014f2772d8ff3402915d3ecf25187514d01f8f00505) |
| 14 | agent pays 2 USDC (within the limit, still allowed) | SUCCESS | [c89abcd1f2ca…](https://stellar.expert/explorer/testnet/tx/c89abcd1f2ca824f35778711bf07457c4ab0de449b49266681c8785ec3198a67) |

## The rejected 10 USDC payment

The transaction is meant to fail, and it fails on-chain with `Error(Contract, #3221)`, which is
`SpendingLimitError::SpendingLimitExceeded` from `stellar_accounts::policies::spending_limit`. The policy's
`enforce` raises it from inside the smart account's `__check_auth`, so the host returns
`Error(Auth, InvalidAction)` to the USDC contract and the transfer never runs.

On-chain diagnostic events:

```
{"tx_failed":[{"op_inner":{"invoke_host_function":"trapped"}}]}
CBTDPBAOKKRC4UYNQOHNKT63NL76RMD6W2HRQTMUIEGA6NLUQJVP4YJP Error(Contract, #3221) failing with contract error
CBTDPBAOKKRC4UYNQOHNKT63NL76RMD6W2HRQTMUIEGA6NLUQJVP4YJP Error(Contract, #3221) escalating error to VM trap from failed host function call: fail_with_error
CDB4MZ72JM3KA35WHGWD33KA3HH5GSU6RGAO3RS2M7EAADPPCSOG75II Error(Contract, #3221) contract call failed
CDB4MZ72JM3KA35WHGWD33KA3HH5GSU6RGAO3RS2M7EAADPPCSOG75II Error(Contract, #3221) escalating error to VM trap from failed host function call: call
CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA Error({"auth":"invalid_action"}) failed account authentication with error
```

Simulation (enforcing auth mode) also rejected it before submission:

```
HostError: Error(Auth, InvalidAction)

Event log (newest first):
   0: [Diagnostic Event] contract:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA, topics:[error, Error(Auth, InvalidAction)], data:["failed account authentication with error", CDB4MZ72JM3KA35WHGWD33KA3HH5GSU6RGAO3RS2M7EAADPPCSOG75II, Error(Contract, #3221)]
   1: [Failed Diagnostic Event (not emitted)] contract:CDB4MZ72JM3KA35WHGWD33KA3HH5GSU6RGAO3RS2M7EAADPPCSOG75II, topics:[log], data:["VM call trapped with HostError", __check_auth, Error(Contract, #3221)]
   2: [Failed Diagnostic Event (not emitted)] contract:CDB4MZ72JM3KA35WHGWD33KA3HH5GSU6RGAO3RS2M7EAADPPCSOG75II, topics:[error, Error(Contract, #3221)], data:"escalating error to VM trap from failed host function call: call"
   3: [Failed Diagnostic Event (not emitted)] contract:CDB4MZ72JM3KA35WHGWD33KA3HH5GSU6RGAO3RS2M7EAADPPCSOG75II, topics:[error, Error(Contract, #3221)], data:["contract call failed", enforce, [[Contract, {args: [CDB4MZ72JM3KA35WHGWD33KA3HH5GSU6RGAO3RS2M7EAADPPCSOG75II, GB3WNAVXMVP6TDJ6CN3TVD5GO5LDZA52U7G44X76UQR7JAKXE6DAEBN6, 100000000], contract: CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA, fn_name: transfer}], [[External, CACX7VUUKW6MUJ5FCNHZRTK7ZXAAQ6RSHRGX24HNVNMX2TXMUKS4POZ7, Bytes(361e7a0157ae247931b9a92728dd3198c5207a3d392719b12214a2743a78a9bf)]], {context_type: [CallContract, CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA], id: 1, name: "agent-usdc", policies: [CBTDPBAOKKRC4UYNQOHNKT63NL76RMD6W2HRQTMUIEGA6NLUQJVP4YJP], policy_ids: [0], signer_ids: [1], signers: [[External, CACX7VUUKW6MUJ5FCNHZRTK7ZXAAQ6RSHRGX24HNVNMX2TXMUKS4POZ7, Bytes(361e7a0157ae247931b9a92728dd3198c5207a3d392719b12214a2743a78a9bf)]], valid_until: Void}, CDB4MZ72JM3KA35WHGWD33KA3HH5GSU6RGAO3RS2M7EAADPPCSOG75II]]
   4: [Failed Diagnostic Event (not emitted)] contract:CBTDPBAOKKRC4UYNQOHNKT63NL76RMD6W2HRQTMUIEGA6NLUQJVP4YJP, topics:[log], data:["VM call trapped with HostError", enforce, Error(Contract, #3221)]
```
