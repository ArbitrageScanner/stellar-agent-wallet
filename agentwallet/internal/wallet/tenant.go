package wallet

// Multi-tenant flows. Each user owns a smart account whose rule #0 signer is
// Delegated(user's G address): the service never holds the owner key.
//
// Owner actions are two-phase:
//
//	Prepare -> the user's wallet signs the returned auth preimage
//	(Freighter signAuthEntry) -> Submit
//
// and so are transactions the user's account is the source of (top-ups,
// trustlines): Prepare returns an unsigned tx for signTransaction.

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"math/big"

	"github.com/stellar/go-stellar-sdk/keypair"
	"github.com/stellar/go-stellar-sdk/network"
	protocol "github.com/stellar/go-stellar-sdk/protocols/rpc"
	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/txnbuild"
	"github.com/stellar/go-stellar-sdk/xdr"

	sv "github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/stellar"
)

// OwnerRule is the context rule controlled by the user's wallet.
const OwnerRule = 0

// DelegatedSigner encodes Signer::Delegated(address).
func DelegatedSigner(address string) xdr.ScVal { return sv.Enum("Delegated", sv.MustAddr(address)) }

func accountSalt(owner string) xdr.Uint256 {
	return xdr.Uint256(sha256.Sum256([]byte("agentwallet/account/v1/" + owner)))
}

func (w *Wallet) contractIDPreimage(owner string) xdr.ContractIdPreimage {
	deployer, _ := sv.ScAddress(w.cfg.Relayer.Address())
	return xdr.ContractIdPreimage{
		Type:        xdr.ContractIdPreimageTypeContractIdPreimageFromAddress,
		FromAddress: &xdr.ContractIdPreimageFromAddress{Address: deployer, Salt: accountSalt(owner)},
	}
}

// AccountAddress is the deterministic smart account address of a user: the
// primary relayer deploys it with salt sha256("agentwallet/account/v1/" + G).
func (w *Wallet) AccountAddress(owner string) (string, error) {
	pre := xdr.HashIdPreimage{
		Type: xdr.EnvelopeTypeEnvelopeTypeContractId,
		ContractId: &xdr.HashIdPreimageContractId{
			NetworkId:          xdr.Hash(network.ID(w.cfg.Passphrase)),
			ContractIdPreimage: w.contractIDPreimage(owner),
		},
	}
	raw, err := pre.MarshalBinary()
	if err != nil {
		return "", err
	}
	id := sha256.Sum256(raw)
	return strkey.Encode(strkey.VersionByteContract, id[:])
}

// AccountExists reports whether the smart account is deployed.
func (w *Wallet) AccountExists(ctx context.Context, account string) (bool, error) {
	_, err := w.Call(ctx, account, "get_context_rules_count")
	if err == nil {
		return true, nil
	}
	if e := AsError(err); e.Code == "rpc_error" {
		return false, err
	}
	return false, nil
}

// DeployAccount deploys the user's smart account (rule #0 = Delegated(owner))
// if it does not exist yet. The relayer pays; no user signature is needed,
// since the result is only ever controlled by owner.
func (w *Wallet) DeployAccount(ctx context.Context, owner string, accountWasm xdr.Hash) (string, *Tx, *Error) {
	if !strkey.IsValidEd25519PublicKey(owner) {
		return "", nil, errf("invalid_argument", "owner must be a G… account")
	}
	addr, err := w.AccountAddress(owner)
	if err != nil {
		return "", nil, AsError(err)
	}
	if ok, err := w.AccountExists(ctx, addr); err != nil {
		return "", nil, AsError(err)
	} else if ok {
		return addr, nil, nil
	}
	op := &txnbuild.InvokeHostFunction{
		HostFunction: xdr.HostFunction{
			Type: xdr.HostFunctionTypeHostFunctionTypeCreateContractV2,
			CreateContractV2: &xdr.CreateContractArgsV2{
				ContractIdPreimage: w.contractIDPreimage(owner),
				Executable:         xdr.ContractExecutable{Type: xdr.ContractExecutableTypeContractExecutableWasm, WasmHash: &accountWasm},
				ConstructorArgs:    []xdr.ScVal{sv.Vec(DelegatedSigner(owner)), sv.Map()},
			},
		},
		SourceAccount: w.cfg.Relayer.Address(),
	}
	// the deployer (primary relayer) authorizes the deploy as tx source, so
	// this one cannot go through the pool
	defer w.lockSource(w.cfg.Relayer.Address())()
	tx, err := w.build(ctx, w.cfg.Relayer, op)
	if err != nil {
		return "", nil, AsError(err)
	}
	sim, err := w.simulate(ctx, tx, "record")
	if err != nil {
		return "", nil, AsError(err)
	}
	if sim.Error != "" {
		return "", nil, classify(sim.Error)
	}
	auth, err := decodeAuth(sim)
	if err != nil {
		return "", nil, AsError(err)
	}
	ready, err := w.assemble(ctx, w.cfg.Relayer, op, auth, sim, 1)
	if err != nil {
		return "", nil, AsError(err)
	}
	res, err := w.submit(ctx, ready, w.cfg.Relayer)
	if err != nil {
		return "", nil, AsError(err)
	}
	if res.Status != "SUCCESS" {
		return "", res, res.Error
	}
	return addr, res, nil
}

// ---------------------------------------------------------------- owner calls

// OwnerCall is a prepared call that needs the owner's wallet signature.
type OwnerCall struct {
	Account  string
	Owner    string
	Contract string
	Fn       string
	Args     []xdr.ScVal

	// Preimage is the base64 HashIdPreimage the wallet signs
	// (Freighter signAuthEntry); Hash is sha256 of it, the signed message.
	Preimage string
	Hash     []byte

	accountEntry  xdr.SorobanAuthorizationEntry
	delegateEntry xdr.SorobanAuthorizationEntry
}

func randomNonce() xdr.Int64 {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return xdr.Int64(int64(binary.BigEndian.Uint64(b[:]) >> 1))
}

// PrepareOwnerCall builds the auth entries for contract.fn(args) authorized by
// account under rule #0 through its Delegated owner.
func (w *Wallet) PrepareOwnerCall(ctx context.Context, account, owner, contract, fn string, args []xdr.ScVal) (*OwnerCall, *Error) {
	op, err := w.invokeOp(w.cfg.Relayer.Address(), contract, fn, args)
	if err != nil {
		return nil, AsError(err)
	}
	tx, err := w.buildSim(w.cfg.Relayer, op)
	if err != nil {
		return nil, AsError(err)
	}
	sim, err := w.simulate(ctx, tx, "record")
	if err != nil {
		return nil, AsError(err)
	}
	if sim.Error != "" {
		return nil, classify(sim.Error)
	}
	entries, err := decodeAuth(sim)
	if err != nil {
		return nil, AsError(err)
	}
	acct, _ := sv.ScAddress(account)
	var ae *xdr.SorobanAuthorizationEntry
	for i := range entries {
		if c := addressCreds(&entries[i].Credentials); c != nil && c.Address.Equals(acct) {
			ae = &entries[i]
		}
	}
	if ae == nil || len(entries) != 1 {
		return nil, errf("invalid_argument", "%s.%s needs authorization other than the account's (%d entries)", contract, fn, len(entries))
	}
	latest, err := w.LatestLedger(ctx)
	if err != nil {
		return nil, AsError(err)
	}
	expiration := latest + 120 // ~10 minutes to sign in the wallet
	c := addressCreds(&ae.Credentials)
	c.SignatureExpirationLedger = xdr.Uint32(expiration)
	payload, err := w.signaturePayload(*ae, c)
	if err != nil {
		return nil, AsError(err)
	}
	ids := make([]xdr.ScVal, countInvocations(ae.RootInvocation))
	for i := range ids {
		ids[i] = sv.U32(OwnerRule)
	}
	digestPreimage := sv.Struct(map[string]xdr.ScVal{
		"account":           sv.MustAddr(account),
		"context_rule_ids":  sv.Vec(ids...),
		"signature_payload": sv.Bytes(payload[:]),
	})
	c.Signature = sv.Struct(map[string]xdr.ScVal{
		"context_rule_ids": sv.Vec(ids...),
		"signers":          sv.Map(xdr.ScMapEntry{Key: DelegatedSigner(owner), Val: sv.Bytes(nil)}),
	})

	ownerAddr, err := sv.ScAddress(owner)
	if err != nil {
		return nil, AsError(err)
	}
	de := xdr.SorobanAuthorizationEntry{
		Credentials: xdr.SorobanCredentials{
			Type: xdr.SorobanCredentialsTypeSorobanCredentialsAddress,
			Address: &xdr.SorobanAddressCredentials{
				Address: ownerAddr, Nonce: randomNonce(),
				SignatureExpirationLedger: xdr.Uint32(expiration),
				Signature:                 sv.Void(),
			},
		},
		RootInvocation: xdr.SorobanAuthorizedInvocation{
			Function: xdr.SorobanAuthorizedFunction{
				Type: xdr.SorobanAuthorizedFunctionTypeSorobanAuthorizedFunctionTypeContractFn,
				ContractFn: &xdr.InvokeContractArgs{
					ContractAddress: acct,
					FunctionName:    "__check_auth",
					Args:            []xdr.ScVal{digestPreimage},
				},
			},
		},
	}
	pre := xdr.HashIdPreimage{
		Type: xdr.EnvelopeTypeEnvelopeTypeSorobanAuthorization,
		SorobanAuthorization: &xdr.HashIdPreimageSorobanAuthorization{
			NetworkId:                 xdr.Hash(network.ID(w.cfg.Passphrase)),
			Nonce:                     de.Credentials.Address.Nonce,
			SignatureExpirationLedger: de.Credentials.Address.SignatureExpirationLedger,
			Invocation:                de.RootInvocation,
		},
	}
	raw, err := pre.MarshalBinary()
	if err != nil {
		return nil, AsError(err)
	}
	h := sha256.Sum256(raw)
	return &OwnerCall{
		Account: account, Owner: owner, Contract: contract, Fn: fn, Args: args,
		Preimage: base64.StdEncoding.EncodeToString(raw), Hash: h[:],
		accountEntry: *ae, delegateEntry: de,
	}, nil
}

// SubmitOwnerCall attaches the owner's ed25519 signature over oc.Hash and
// submits the call through the relayer pool.
func (w *Wallet) SubmitOwnerCall(ctx context.Context, oc *OwnerCall, signature []byte) (*Tx, *Error) {
	pub, err := rawPublicKey(oc.Owner)
	if err != nil {
		return nil, AsError(err)
	}
	if len(signature) != ed25519.SignatureSize || !ed25519.Verify(pub, oc.Hash, signature) {
		return nil, errf("signature_invalid", "the wallet signature does not match the prepared authorization for %s", oc.Owner)
	}
	de := oc.delegateEntry
	creds := *de.Credentials.Address
	creds.Signature = sv.Vec(sv.Struct(map[string]xdr.ScVal{
		"public_key": sv.Bytes(pub),
		"signature":  sv.Bytes(signature),
	}))
	de.Credentials.Address = &creds
	auth := []xdr.SorobanAuthorizationEntry{oc.accountEntry, de}

	op, err := w.invokeOp(w.cfg.Relayer.Address(), oc.Contract, oc.Fn, oc.Args)
	if err != nil {
		return nil, AsError(err)
	}
	op.Auth = auth
	tx, err := w.buildSim(w.cfg.Relayer, op)
	if err != nil {
		return nil, AsError(err)
	}
	sim, err := w.simulate(ctx, tx, "enforce")
	if err != nil {
		return nil, AsError(err)
	}
	if sim.Error != "" {
		e := classify(sim.Error)
		e.Details = mergeDetails(e.Details, map[string]any{"simulation": firstLine(sim.Error)})
		return nil, e
	}
	op, _ = w.invokeOp(w.cfg.Relayer.Address(), oc.Contract, oc.Fn, oc.Args)
	res, err := w.relayed(ctx, op, auth, sim, 1)
	if err != nil {
		return nil, AsError(err)
	}
	if res.Status != "SUCCESS" {
		res.Error.Tx = res
		return res, res.Error
	}
	return res, nil
}

// Owner-call builders for the user's smart account.

func (w *Wallet) PrepareAddAgent(ctx context.Context, account, owner, name string, agent keypair.KP, limit *big.Int, periodLedgers uint32, validUntil *uint32) (*OwnerCall, *Error) {
	until := sv.Void()
	if validUntil != nil {
		until = sv.U32(*validUntil)
	}
	policies := sv.Map()
	if limit != nil {
		policies = sv.Map(xdr.ScMapEntry{
			Key: sv.MustAddr(w.cfg.Policy),
			Val: sv.Struct(map[string]xdr.ScVal{"period_ledgers": sv.U32(periodLedgers), "spending_limit": sv.I128(limit)}),
		})
	}
	return w.PrepareOwnerCall(ctx, account, owner, account, "add_context_rule", []xdr.ScVal{
		sv.Enum("CallContract", sv.MustAddr(w.cfg.USDC)),
		sv.Str(name),
		until,
		sv.Vec(w.ExternalSigner(agent)),
		policies,
	})
}

func (w *Wallet) PrepareSetValidUntil(ctx context.Context, account, owner string, ruleID uint32, validUntil *uint32) (*OwnerCall, *Error) {
	until := sv.Void()
	if validUntil != nil {
		until = sv.U32(*validUntil)
	}
	return w.PrepareOwnerCall(ctx, account, owner, account, "update_context_rule_valid_until", []xdr.ScVal{sv.U32(ruleID), until})
}

func (w *Wallet) PrepareRemoveRule(ctx context.Context, account, owner string, ruleID uint32) (*OwnerCall, *Error) {
	return w.PrepareOwnerCall(ctx, account, owner, account, "remove_context_rule", []xdr.ScVal{sv.U32(ruleID)})
}

// PrepareSetLimit changes an installed spending limit, or installs the policy.
func (w *Wallet) PrepareSetLimit(ctx context.Context, account, owner string, ruleID uint32, limit *big.Int, periodLedgers uint32) (*OwnerCall, *Error) {
	rule, err := w.Rule(ctx, ruleID)
	if err != nil {
		return nil, AsError(err)
	}
	for _, p := range rule.Policies {
		if p == w.cfg.Policy {
			return w.PrepareOwnerCall(ctx, account, owner, w.cfg.Policy, "set_spending_limit",
				[]xdr.ScVal{sv.I128(limit), rule.raw, sv.MustAddr(account)})
		}
	}
	params := sv.Struct(map[string]xdr.ScVal{"period_ledgers": sv.U32(periodLedgers), "spending_limit": sv.I128(limit)})
	return w.PrepareOwnerCall(ctx, account, owner, account, "add_policy", []xdr.ScVal{sv.U32(ruleID), sv.MustAddr(w.cfg.Policy), params})
}

// PrepareWithdraw moves USDC from the smart account back to the owner.
func (w *Wallet) PrepareWithdraw(ctx context.Context, account, owner string, amount *big.Int) (*OwnerCall, *Error) {
	return w.PrepareOwnerCall(ctx, account, owner, w.cfg.USDC, "transfer",
		[]xdr.ScVal{sv.MustAddr(account), sv.MustAddr(owner), sv.I128(amount)})
}

// ---------------------------------------------------------------- user-sourced txs

// UserTx is an unsigned transaction whose source is the user's G account.
type UserTx struct {
	Source string
	XDR    string // base64 envelope for the wallet's signTransaction
	Hash   []byte // tx hash, the message an ed25519 signer signs
	tx     *txnbuild.Transaction
}

func (w *Wallet) userTx(tx *txnbuild.Transaction, source string) (*UserTx, *Error) {
	b64, err := tx.Base64()
	if err != nil {
		return nil, AsError(err)
	}
	h, err := tx.Hash(w.cfg.Passphrase)
	if err != nil {
		return nil, AsError(err)
	}
	return &UserTx{Source: source, XDR: b64, Hash: h[:], tx: tx}, nil
}

// PrepareFund builds owner -> smart account USDC transfer, signed by the user.
func (w *Wallet) PrepareFund(ctx context.Context, owner, account string, amount *big.Int) (*UserTx, *Error) {
	op, err := w.invokeOp(owner, w.cfg.USDC, "transfer", []xdr.ScVal{sv.MustAddr(owner), sv.MustAddr(account), sv.I128(amount)})
	if err != nil {
		return nil, AsError(err)
	}
	acct, err := retry(ctx, func() (txnbuild.Account, error) { return w.rpc.LoadAccount(ctx, owner) })
	if err != nil {
		return nil, errf("invalid_argument", "your account %s is not funded on testnet", owner)
	}
	build := func(o *txnbuild.InvokeHostFunction) (*txnbuild.Transaction, error) {
		return txnbuild.NewTransaction(txnbuild.TransactionParams{
			SourceAccount: acct, IncrementSequenceNum: true, Operations: []txnbuild.Operation{o},
			BaseFee: txnbuild.MinBaseFee, Preconditions: txnbuild.Preconditions{TimeBounds: txnbuild.NewTimeout(600)},
		})
	}
	tx, err := build(op)
	if err != nil {
		return nil, AsError(err)
	}
	sim, err := w.simulate(ctx, tx, "record")
	if err != nil {
		return nil, AsError(err)
	}
	if sim.Error != "" {
		return nil, classify(sim.Error)
	}
	auth, err := decodeAuth(sim)
	if err != nil {
		return nil, AsError(err)
	}
	var data xdr.SorobanTransactionData
	if err := xdr.SafeUnmarshalBase64(sim.TransactionDataXDR, &data); err != nil {
		return nil, AsError(err)
	}
	data.ResourceFee = xdr.Int64(sim.MinResourceFee*13/10 + 1000)
	op, _ = w.invokeOp(owner, w.cfg.USDC, "transfer", []xdr.ScVal{sv.MustAddr(owner), sv.MustAddr(account), sv.I128(amount)})
	op.Auth = auth
	op.Ext = xdr.TransactionExt{V: 1, SorobanData: &data}
	acct, _ = retry(ctx, func() (txnbuild.Account, error) { return w.rpc.LoadAccount(ctx, owner) }) // build again from the same sequence
	tx, err = build(op)
	if err != nil {
		return nil, AsError(err)
	}
	return w.userTx(tx, owner)
}

// PrepareGetTestUSDC builds a USDC trustline (if missing) + DEX buy of amount
// USDC for XLM, for testnet onboarding.
func (w *Wallet) PrepareGetTestUSDC(ctx context.Context, owner string, amount *big.Int, needTrustline bool) (*UserTx, *Error) {
	acct, err := retry(ctx, func() (txnbuild.Account, error) { return w.rpc.LoadAccount(ctx, owner) })
	if err != nil {
		return nil, errf("invalid_argument", "your account %s is not funded on testnet (use friendbot first)", owner)
	}
	var ops []txnbuild.Operation
	if needTrustline {
		line, _ := w.cfg.USDCAsset.ToChangeTrustAsset()
		ops = append(ops, &txnbuild.ChangeTrust{Line: line})
	}
	ops = append(ops, &txnbuild.PathPaymentStrictReceive{
		SendAsset: txnbuild.NativeAsset{}, SendMax: "1000", Destination: owner,
		DestAsset: w.cfg.USDCAsset, DestAmount: sv.FormatAmount(amount),
	})
	tx, err := txnbuild.NewTransaction(txnbuild.TransactionParams{
		SourceAccount: acct, IncrementSequenceNum: true, Operations: ops,
		BaseFee: txnbuild.MinBaseFee, Preconditions: txnbuild.Preconditions{TimeBounds: txnbuild.NewTimeout(600)},
	})
	if err != nil {
		return nil, AsError(err)
	}
	return w.userTx(tx, owner)
}

// SubmitUserTx submits a user-signed tx. signedXDR (from the wallet) wins;
// otherwise signature is a raw ed25519 signature over ut.Hash.
func (w *Wallet) SubmitUserTx(ctx context.Context, ut *UserTx, signedXDR string, signature []byte) (*Tx, *Error) {
	var env xdr.TransactionEnvelope
	if signedXDR != "" {
		if err := xdr.SafeUnmarshalBase64(signedXDR, &env); err != nil {
			return nil, errf("invalid_argument", "signed transaction is not valid XDR")
		}
		// the wallet must have signed exactly what we prepared
		got, err := network.HashTransactionInEnvelope(env, w.cfg.Passphrase)
		if err != nil || string(got[:]) != string(ut.Hash) {
			return nil, errf("signature_invalid", "the wallet returned a different transaction than the one prepared")
		}
	} else {
		pub, err := rawPublicKey(ut.Source)
		if err != nil || !ed25519.Verify(pub, ut.Hash, signature) {
			return nil, errf("signature_invalid", "signature does not match the prepared transaction")
		}
		kp, _ := keypair.ParseAddress(ut.Source)
		tx, err := ut.tx.AddSignatureDecorated(xdr.DecoratedSignature{Hint: xdr.SignatureHint(kp.Hint()), Signature: signature})
		if err != nil {
			return nil, AsError(err)
		}
		env = tx.ToXDR()
	}
	defer w.lockSource(ut.Source)()
	defer w.invalidate()
	b64, err := xdr.MarshalBase64(env)
	if err != nil {
		return nil, AsError(err)
	}
	hash := fmt.Sprintf("%x", ut.Hash)
	sent, err := w.rpc.SendTransaction(ctx, protocol.SendTransactionRequest{Transaction: b64})
	if err != nil {
		return nil, AsError(err)
	}
	if sent.Status == "ERROR" {
		msg := sent.ErrorResultXDR
		var res xdr.TransactionResult
		if xdr.SafeUnmarshalBase64(sent.ErrorResultXDR, &res) == nil {
			msg = res.Result.Code.String()
		}
		return nil, &Error{Code: "tx_rejected", Message: "RPC rejected the transaction: " + msg}
	}
	got, err := w.rpc.PollTransaction(ctx, hash)
	if err != nil {
		return nil, AsError(err)
	}
	out := &Tx{Hash: hash, URL: w.TxURL(hash), Status: got.Status, Ledger: got.Ledger}
	if got.Status != protocol.TransactionStatusSuccess {
		out.Status = "FAILED"
		out.Error = w.describeFailure(ctx, hash)
		out.Error.Tx = out
		return out, out.Error
	}
	return out, nil
}

// ---------------------------------------------------------------- reads

// WalletBalances are the user's own G account balances.
type WalletBalances struct {
	XLM           string `json:"xlm"`
	USDC          string `json:"usdc"`
	USDCTrustline bool   `json:"usdc_trustline"`
	Funded        bool   `json:"funded"`
}

func (w *Wallet) GBalances(ctx context.Context, g string) (WalletBalances, error) {
	out := WalletBalances{XLM: "0", USDC: "0"}
	id, err := xdr.AddressToAccountId(g)
	if err != nil {
		return out, err
	}
	lk, err := id.LedgerKey()
	if err != nil {
		return out, err
	}
	keyB64, err := xdr.MarshalBase64(lk)
	if err != nil {
		return out, err
	}
	// The USDC balance (a simulation) does not depend on the account entry, so
	// fetch it concurrently: Stellar RPC can take seconds per call.
	type usdc struct {
		bal *big.Int
		err error
	}
	ch := make(chan usdc, 1)
	go func() {
		bal, err := w.Balance(ctx, g)
		ch <- usdc{bal, err}
	}()
	res, err := retry(ctx, func() (protocol.GetLedgerEntriesResponse, error) {
		return w.rpc.GetLedgerEntries(ctx, protocol.GetLedgerEntriesRequest{Keys: []string{keyB64}})
	})
	if err != nil {
		return out, err
	}
	if len(res.Entries) == 0 {
		return out, nil // not funded yet
	}
	var data xdr.LedgerEntryData
	if err := xdr.SafeUnmarshalBase64(res.Entries[0].DataXDR, &data); err != nil {
		return out, err
	}
	out.Funded = true
	if data.Account != nil {
		out.XLM = sv.FormatAmount(big.NewInt(int64(data.Account.Balance)))
	}
	u := <-ch
	if bal, err := u.bal, u.err; err == nil {
		out.USDC, out.USDCTrustline = sv.FormatAmount(bal), true
	} else if e := AsError(err); e.Code != "payee_no_trustline" && e.Code != "contract_error" {
		return out, err
	}
	return out, nil
}

// Overview is the state of a user's smart account with every agent rule's
// spending limit.
type Overview struct {
	Address      string           `json:"address"`
	URL          string           `json:"url"`
	Balances     []Balance        `json:"balances"`
	Rules        []Rule           `json:"rules"`
	LatestLedger uint32           `json:"latest_ledger"`
	Limits       map[uint32]Limit `json:"-"`
}

func (w *Wallet) Overview(ctx context.Context) (Overview, error) {
	var (
		latest     uint32
		bal        *big.Int
		rules      []Rule
		e1, e2, e3 error
	)
	done := make(chan struct{}, 3)
	go func() { latest, e1 = w.LatestLedger(ctx); done <- struct{}{} }()
	go func() { bal, e2 = w.Balance(ctx, w.cfg.SmartAccount); done <- struct{}{} }()
	go func() { rules, e3 = w.Rules(ctx); done <- struct{}{} }()
	for i := 0; i < 3; i++ {
		<-done
	}
	for _, err := range []error{e1, e2, e3} {
		if err != nil {
			return Overview{}, err
		}
	}
	ov := Overview{
		Address: w.cfg.SmartAccount, URL: w.cfg.Explorer + "/contract/" + w.cfg.SmartAccount,
		Balances: []Balance{{Asset: "USDC", Contract: w.cfg.USDC, Amount: sv.FormatAmount(bal)}},
		Rules:    rules, LatestLedger: latest, Limits: map[uint32]Limit{},
	}
	type res struct {
		id  uint32
		lim Limit
		err error
	}
	ch := make(chan res)
	n := 0
	for _, r := range rules {
		has := false
		for _, p := range r.Policies {
			has = has || p == w.cfg.Policy
		}
		if !has {
			continue
		}
		n++
		go func(id uint32) {
			h := w.ForAccount(w.cfg.SmartAccount, id, nil)
			data, err := h.spendingData(ctx)
			if err != nil {
				ch <- res{id: id, err: err}
				return
			}
			l, err := computeLimit(data, latest)
			ch <- res{id, l, err}
		}(r.ID)
	}
	for i := 0; i < n; i++ {
		r := <-ch
		if r.err != nil {
			return Overview{}, r.err
		}
		ov.Limits[r.id] = r.lim
	}
	return ov, nil
}
