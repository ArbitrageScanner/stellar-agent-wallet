// Renders deployments/testnet.json (written by demo.mjs) into scripts/TRANSACTIONS.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPLORER = "https://stellar.expert/explorer/testnet";
const run = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "testnet.json"), "utf8"));

const link = (kind, id) => `[\`${id}\`](${EXPLORER}/${kind}/${id})`;
const rows = run.transactions.map(
  (t, i) => `| ${i + 1} | ${t.step} | ${t.status} | [${t.hash.slice(0, 12)}…](${t.url}) |`,
);

const md = `# Testnet run (${run.generated_at})

All transactions below were produced by one \`npm run demo\` run on Stellar testnet.

## Accounts and contracts

| Role | Address |
|---|---|
| Agent wallet (OZ smart account) | ${link("contract", run.contracts.smart_account)} |
| Ed25519 verifier | ${link("contract", run.contracts.ed25519_verifier)} |
| Spending-limit policy | ${link("contract", run.contracts.spending_limit_policy)} |
| USDC (Circle testnet, SAC) | ${link("contract", run.contracts.usdc_sac)} |
${Object.entries(run.accounts)
  .map(([n, a]) => `| ${n} | ${link("account", a)} |`)
  .join("\n")}

## Transactions

| # | Step | Result | Tx |
|---|---|---|---|
${rows.join("\n")}

## The rejected 10 USDC payment

The transaction is meant to fail, and it fails on-chain with \`Error(Contract, #3221)\`, which is
\`SpendingLimitError::SpendingLimitExceeded\` from \`stellar_accounts::policies::spending_limit\`. The policy's
\`enforce\` raises it from inside the smart account's \`__check_auth\`, so the host returns
\`Error(Auth, InvalidAction)\` to the USDC contract and the transfer never runs.

On-chain diagnostic events:

\`\`\`
${run.rejection.onchain_error.split(" | ").join("\n")}
\`\`\`

Simulation (enforcing auth mode) also rejected it before submission:

\`\`\`
${run.rejection.simulation_error.split("\n").slice(0, 8).join("\n")}
\`\`\`
`;

fs.writeFileSync(path.join(ROOT, "scripts", "TRANSACTIONS.md"), md);
console.log("Wrote scripts/TRANSACTIONS.md");
