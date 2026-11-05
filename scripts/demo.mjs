// End-to-end demo on Stellar testnet:
//   1. deploy an OpenZeppelin smart account for an AI agent
//   2. a "user" tops it up with 10 testnet USDC
//   3. the agent pays 1 USDC to a payee
//   4. a 5 USDC/day spending-limit policy is installed; a 10 USDC payment is rejected
//   5. every transaction is logged with a stellar.expert link
//
// Secret keys live in .secrets/keys.json (git-ignored) and never leave this machine.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  Address,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const EXPLORER = "https://stellar.expert/explorer/testnet";

// Circle testnet USDC (the asset https://faucet.circle.com sends on Stellar testnet).
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const USDC_SAC = USDC.contractId(PASSPHRASE);
const UNIT = 10_000_000n; // USDC has 7 decimals on Stellar
const DAY_IN_LEDGERS = 17_280; // ~5s ledgers

const server = new rpc.Server(RPC_URL);
const horizon = new Horizon.Server(HORIZON_URL);

const log = [];
const record = (step, hash, status, extra = {}) => {
  const entry = { step, hash, status, url: `${EXPLORER}/tx/${hash}`, ...extra };
  log.push(entry);
  console.log(`  [${status}] ${step}\n           ${entry.url}`);
  return entry;
};

// ---------------------------------------------------------------- keys & state

function loadKeys() {
  const file = path.join(ROOT, ".secrets", "keys.json");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fresh = Object.fromEntries(
      ["relayer", "user", "agent", "payee"].map((n) => [n, Keypair.random().secret()]),
    );
    fs.writeFileSync(file, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Object.fromEntries(Object.entries(raw).map(([n, s]) => [n, Keypair.fromSecret(s)]));
}

// ---------------------------------------------------------------- ScVal helpers

const sym = (s) => xdr.ScVal.scvSymbol(s);
const u32 = (n) => xdr.ScVal.scvU32(n);
const bytes = (b) => xdr.ScVal.scvBytes(Buffer.from(b));
const addr = (a) => new Address(a).toScVal();
const i128 = (n) => nativeToScVal(n, { type: "i128" });
// #[contracttype] structs are maps with symbol keys sorted lexicographically.
const struct = (fields) =>
  xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: fields[k] })),
  );

// stellar_accounts::smart_account::Signer::External(verifier, public_key)
const externalSigner = (verifier, kp) =>
  xdr.ScVal.scvVec([sym("External"), addr(verifier), bytes(kp.rawPublicKey())]);

// ---------------------------------------------------------------- tx plumbing

async function send(tx, signers, step) {
  for (const kp of signers) tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") {
    const err = JSON.stringify(sent.errorResult?.toJson?.() ?? sent.errorResult ?? "unknown");
    record(step, sent.hash, "REJECTED_BY_RPC", { error: err });
    throw new Error(`${step}: sendTransaction ERROR ${err}`);
  }
  const res = await server.pollTransaction(sent.hash, { attempts: 60 });
  if (res.status !== "SUCCESS") {
    const error = await describeFailure(sent.hash);
    record(step, sent.hash, "FAILED", { error });
    return { hash: sent.hash, ok: false, error, res };
  }
  record(step, sent.hash, "SUCCESS");
  return { hash: sent.hash, ok: true, res };
}

// Pull the failed tx back as JSON-encoded XDR and keep the parts a human needs:
// the tx/op result codes and the contract error events from the diagnostics.
async function describeFailure(hash) {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash, xdrFormat: "json" } }),
  }).then((x) => x.json());
  const t = r.result ?? {};
  const parts = [JSON.stringify(t.resultJson?.result ?? t.status)];
  for (const ev of t.diagnosticEventsJson ?? []) {
    const body = ev.event?.body?.v0;
    if (body?.topics?.[0]?.symbol !== "error") continue;
    const err = body.topics[1]?.error ?? {};
    const code = err.contract !== undefined ? `Error(Contract, #${err.contract})` : `Error(${JSON.stringify(err)})`;
    const msg = body.data?.string ?? body.data?.vec?.find((v) => v.string)?.string ?? "";
    const line = `${ev.event.contract_id ?? ""} ${code} ${msg}`.trim();
    if (!parts.includes(line)) parts.push(line);
  }
  return parts.join(" | ");
}

async function builder(source) {
  return new TransactionBuilder(await server.getAccount(source.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  }).setTimeout(300);
}

// Plain Soroban call where the tx source account is the only authorizer.
async function invokeAsSource(source, contract, fn, args, step) {
  const tx = (await builder(source))
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args }))
    .build();
  const prepared = await server.prepareTransaction(tx);
  return send(prepared, [source], step);
}

/**
 * Call `contract.fn(args)` where `smartAccount` must authorize, signed by an
 * External ed25519 signer of the context rule(s) in `ruleIds`. `relayer` only
 * pays fees.
 *
 * The signer signs the OZ auth digest:
 *   sha256(xdr(AuthDigestPreimage { account, context_rule_ids, signature_payload }))
 * and the account receives AuthPayload { context_rule_ids, signers: {Signer -> sig} }.
 *
 * If simulation rejects the call and `forceSubmit` is given, the transaction is
 * still sent on-chain (using the footprint of a "probe" call that does pass), so
 * the rejection is recorded as a failed transaction on the ledger.
 */
async function invokeAsSmartAccount({ relayer, smartAccount, verifier, signer, ruleIds, contract, fn, args, step, forceSubmit }) {
  const buildTx = async (callArgs, auth) =>
    (await builder(relayer))
      .addOperation(Operation.invokeContractFunction({ contract, function: fn, args: callArgs, auth }))
      .build();

  const signEntries = async (entries, nonceOverride) => {
    const latest = (await server.getLatestLedger()).sequence;
    const out = [];
    for (let entry of entries) {
      const creds = entry.credentials;
      const addrCreds = creds.value?.addressCredentials ?? creds.value;
      const isOurs = addrCreds?.address && Address.fromScAddress(addrCreds.address).toString() === smartAccount;
      if (!isOurs) {
        out.push(entry);
        continue;
      }
      if (nonceOverride !== undefined) addrCreds.nonce = nonceOverride;
      entry = await authorizeEntry(
        entry,
        async (_preimage, signaturePayload) => {
          const ids = xdr.ScVal.scvVec(ruleIds.map(u32));
          const digest = crypto
            .createHash("sha256")
            .update(
              struct({
                account: addr(smartAccount),
                context_rule_ids: ids,
                signature_payload: bytes(signaturePayload),
              }).toXDR(),
            )
            .digest();
          const sig = signer.sign(digest);
          const signatureScVal = struct({
            context_rule_ids: ids,
            signers: xdr.ScVal.scvMap([
              new xdr.ScMapEntry({ key: externalSigner(verifier, signer), val: bytes(sig) }),
            ]),
          });
          return { signatureScVal, address: smartAccount };
        },
        latest + 200,
        PASSPHRASE,
        smartAccount,
      );
      out.push(entry);
    }
    return out;
  };

  const recordSim = async (callArgs) => server.simulateTransaction(await buildTx(callArgs, []));

  // 1) recording-mode simulation gives the auth entries (nonce, invocation tree).
  //    Recording mode skips __check_auth, so a call the policy would reject can
  //    still fail here for an unrelated reason (e.g. SAC balance check). In that
  //    case record a passing probe call and put the real args into its auth tree.
  let rec = await recordSim(args);
  let recordedAuth;
  if (!rpc.Api.isSimulationError(rec)) {
    recordedAuth = rec.result.auth;
  } else if (forceSubmit) {
    console.log(`  [record-mode sim failed, using probe auth tree] ${rec.error.split("\n")[0]}`);
    const probeRec = await recordSim(forceSubmit.probeArgs);
    if (rpc.Api.isSimulationError(probeRec)) throw new Error(`${step}: probe simulation failed: ${probeRec.error}`);
    recordedAuth = probeRec.result.auth.map((e) => {
      const copy = xdr.SorobanAuthorizationEntry.fromXdr(e.toXdr());
      copy.rootInvocation.function.contractFn.args = args;
      return copy;
    });
  } else {
    throw new Error(`${step}: simulation (record) failed: ${rec.error}`);
  }
  const nonce = recordedAuth
    .map((e) => e.credentials.value?.addressCredentials ?? e.credentials.value)
    .find((c) => c?.nonce !== undefined)?.nonce;
  const signed = await signEntries(recordedAuth);

  // 2) enforcing simulation runs __check_auth (signature, context rule, policies)
  const signedTx = await buildTx(args, signed);
  const enf = await server.simulateTransaction(signedTx, undefined, "enforce");
  if (!rpc.Api.isSimulationError(enf)) {
    const ready = rpc.assembleTransaction(signedTx, enf).build();
    return send(ready, [relayer], step);
  }

  const simError = enf.error;
  console.log(`  [SIMULATION REJECTED] ${step}\n           ${simError.split("\n")[0]}`);
  if (!forceSubmit) return { ok: false, simError };

  // 3) submit anyway so the rejection is visible on-chain. Footprint/resources
  //    come from a passing probe call that touches the same ledger keys
  //    (same accounts, same policy, same nonce).
  const probeRec = await recordSim(forceSubmit.probeArgs);
  const probeSigned = await signEntries(probeRec.result.auth, nonce);
  const probe = await server.simulateTransaction(await buildTx(forceSubmit.probeArgs, probeSigned), undefined, "enforce");
  if (rpc.Api.isSimulationError(probe)) throw new Error(`${step}: probe simulation failed: ${probe.error}`);
  const r = probe.transactionData.build().resources;
  const resourceFee = BigInt(probe.minResourceFee) * 2n;
  const sorobanData = probe.transactionData
    .setResources(Math.ceil(r.instructions * 1.3), r.diskReadBytes, r.writeBytes)
    .setResourceFee(resourceFee.toString())
    .build();
  const forced = TransactionBuilder.cloneFrom(signedTx, { fee: (resourceFee + 1000n).toString(), sorobanData }).build();
  const out = await send(forced, [relayer], step);
  return { ...out, simError };
}

async function deployWasm(relayer, file, step) {
  const wasm = fs.readFileSync(path.join(ROOT, "target/wasm32v1-none/release", file));
  const tx = (await builder(relayer)).addOperation(Operation.uploadContractWasm({ wasm })).build();
  await send(await server.prepareTransaction(tx), [relayer], step);
  return crypto.createHash("sha256").update(wasm).digest();
}

async function deployContract(relayer, wasmHash, constructorArgs, step) {
  const tx = (await builder(relayer))
    .addOperation(
      Operation.createCustomContract({
        address: new Address(relayer.publicKey()),
        wasmHash,
        salt: crypto.randomBytes(32),
        constructorArgs,
      }),
    )
    .build();
  const { res } = await send(await server.prepareTransaction(tx), [relayer], step);
  return Address.fromScVal(res.returnValue).toString();
}

async function classic(source, ops, step) {
  const account = await horizon.loadAccount(source.publicKey());
  let b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE }).setTimeout(300);
  for (const op of ops) b = b.addOperation(op);
  const tx = b.build();
  tx.sign(source);
  try {
    const r = await horizon.submitTransaction(tx);
    record(step, r.hash, "SUCCESS");
  } catch (e) {
    const codes = JSON.stringify(e?.response?.data?.extras?.result_codes ?? e.message);
    record(step, tx.hash().toString("hex"), "FAILED", { error: codes });
    throw new Error(`${step}: ${codes}`);
  }
}

const usdcBalance = async (who) => {
  const sim = await server.simulateTransaction(
    (await builder(keys.relayer))
      .addOperation(Operation.invokeContractFunction({ contract: USDC_SAC, function: "balance", args: [addr(who)] }))
      .build(),
  );
  const n = BigInt(scValToNative(sim.result.retval));
  return `${Number(n) / Number(UNIT)} USDC`;
};

// ---------------------------------------------------------------- the demo

const keys = loadKeys();

async function main() {
  console.log("Accounts (public keys only):");
  for (const [n, kp] of Object.entries(keys)) console.log(`  ${n.padEnd(8)} ${kp.publicKey()}`);
  console.log(`  USDC SAC ${USDC_SAC}\n`);

  console.log("0. Funding classic accounts with friendbot (XLM for fees)");
  for (const n of ["relayer", "user", "payee"]) {
    try {
      await server.getAccount(keys[n].publicKey());
    } catch {
      await server.fundAddress(keys[n].publicKey());
    }
  }

  console.log("\n1. Creating the agent wallet (OpenZeppelin smart account)");
  const verifierHash = await deployWasm(keys.relayer, "agent_ed25519_verifier.wasm", "upload ed25519 verifier wasm");
  const policyHash = await deployWasm(keys.relayer, "agent_spending_limit_policy.wasm", "upload spending-limit policy wasm");
  const accountHash = await deployWasm(keys.relayer, "agent_account.wasm", "upload smart account wasm");
  const verifier = await deployContract(keys.relayer, verifierHash, [], "deploy ed25519 verifier");
  const policy = await deployContract(keys.relayer, policyHash, [], "deploy spending-limit policy");
  // Default rule (id 0): the user's key is the owner/admin of the wallet.
  const smartAccount = await deployContract(
    keys.relayer,
    accountHash,
    [xdr.ScVal.scvVec([externalSigner(verifier, keys.user)]), xdr.ScVal.scvMap([])],
    "deploy smart account (owner = user's ed25519 key, rule #0 Default)",
  );
  console.log(`  verifier      ${verifier}\n  policy        ${policy}\n  smart account ${smartAccount}`);

  // Rule id 1: the agent key may only call the USDC contract.
  const ownerCall = (fn, args, step) =>
    invokeAsSmartAccount({
      relayer: keys.relayer, smartAccount, verifier, signer: keys.user, ruleIds: [0],
      contract: smartAccount, fn, args, step,
    });
  await ownerCall(
    "add_context_rule",
    [
      xdr.ScVal.scvVec([sym("CallContract"), addr(USDC_SAC)]),
      xdr.ScVal.scvString("agent-usdc"),
      xdr.ScVal.scvVoid(),
      xdr.ScVal.scvVec([externalSigner(verifier, keys.agent)]),
      xdr.ScVal.scvMap([]),
    ],
    "owner adds context rule #1: CallContract(USDC) signed by the agent key",
  );
  const AGENT_RULE = 1;

  console.log("\n2. User gets 10 testnet USDC and tops up the agent wallet");
  await classic(keys.payee, [Operation.changeTrust({ asset: USDC })], "payee: trustline to USDC");
  await classic(
    keys.user,
    [
      Operation.changeTrust({ asset: USDC }),
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(), sendMax: "50", destination: keys.user.publicKey(),
        destAsset: USDC, destAmount: "10", path: [],
      }),
    ],
    "user: trustline + buy 10 Circle testnet USDC for XLM on the testnet DEX",
  );
  await invokeAsSource(
    keys.user, USDC_SAC, "transfer",
    [addr(keys.user.publicKey()), addr(smartAccount), i128(10n * UNIT)],
    "user tops up agent wallet with 10 USDC",
  );
  console.log(`  agent wallet balance: ${await usdcBalance(smartAccount)}`);

  const agentPay = (amount, step, forceSubmit) =>
    invokeAsSmartAccount({
      relayer: keys.relayer, smartAccount, verifier, signer: keys.agent, ruleIds: [AGENT_RULE],
      contract: USDC_SAC, fn: "transfer",
      args: [addr(smartAccount), addr(keys.payee.publicKey()), i128(amount)],
      step, forceSubmit,
    });

  console.log("\n3. Agent pays 1 USDC to the payee");
  const pay1 = await agentPay(1n * UNIT, "agent pays 1 USDC to payee");
  if (!pay1.ok) throw new Error(`1 USDC payment failed: ${pay1.error ?? pay1.simError}`);
  console.log(`  agent wallet: ${await usdcBalance(smartAccount)}, payee: ${await usdcBalance(keys.payee.publicKey())}`);

  console.log("\n4. Owner installs a 5 USDC / day spending limit on the agent rule");
  await ownerCall(
    "add_policy",
    [u32(AGENT_RULE), addr(policy), struct({ period_ledgers: u32(DAY_IN_LEDGERS), spending_limit: i128(5n * UNIT) })],
    "owner adds spending-limit policy (5 USDC / 17280 ledgers) to rule #1",
  );

  const pay10 = await agentPay(10n * UNIT, "agent tries to pay 10 USDC (must be rejected)", {
    probeArgs: [addr(smartAccount), addr(keys.payee.publicKey()), i128(1n)],
  });
  if (pay10.ok) throw new Error("10 USDC payment unexpectedly succeeded");

  const pay2 = await agentPay(2n * UNIT, "agent pays 2 USDC (within the limit, still allowed)");
  console.log(`  agent wallet: ${await usdcBalance(smartAccount)}, payee: ${await usdcBalance(keys.payee.publicKey())}`);

  const summary = {
    network: "testnet",
    generated_at: new Date().toISOString(),
    accounts: Object.fromEntries(Object.entries(keys).map(([n, kp]) => [n, kp.publicKey()])),
    contracts: { usdc_sac: USDC_SAC, ed25519_verifier: verifier, spending_limit_policy: policy, smart_account: smartAccount },
    rejection: { simulation_error: pay10.simError, onchain_error: pay10.error },
    within_limit_after_policy: pay2.ok,
    transactions: log,
  };
  fs.mkdirSync(path.join(ROOT, "deployments"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "deployments", "testnet.json"), JSON.stringify(summary, null, 2));
  console.log("\nWrote deployments/testnet.json");
}

main().catch((e) => {
  console.error("\nFAILED:", e?.response?.data ?? e);
  fs.writeFileSync(path.join(ROOT, "deployments", "testnet.partial.json"), JSON.stringify({ error: String(e), transactions: log }, null, 2));
  process.exit(1);
});
