// Package wallet drives an OpenZeppelin smart account on Stellar: it builds
// contract calls, signs the account's auth entries with an External ed25519
// signer of a given context rule, simulates, and submits through a relayer
// that only pays fees.
package wallet

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/stellar/go-stellar-sdk/clients/rpcclient"
	"github.com/stellar/go-stellar-sdk/keypair"
	"github.com/stellar/go-stellar-sdk/network"
	protocol "github.com/stellar/go-stellar-sdk/protocols/rpc"
	"github.com/stellar/go-stellar-sdk/txnbuild"
	"github.com/stellar/go-stellar-sdk/xdr"

	sv "github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/stellar"
)

type Config struct {
	RPCURL     string
	Passphrase string
	Explorer   string

	SmartAccount string // C… OZ smart account
	Verifier     string // C… ed25519 verifier used by External signers
	Policy       string // C… spending-limit policy
	USDC         string // C… USDC SAC
	USDCAsset    txnbuild.CreditAsset
	AgentRule    uint32

	Relayer *keypair.Full // pays fees, never an authorizer; also used as the simulation source
	// Relayers is a pool of fee-paying channel accounts (defaults to [Relayer]).
	// Each has its own sequence number, so submissions run in parallel.
	Relayers []*keypair.Full
	Agent    *keypair.Full // External signer of AgentRule

	// RecordRejections submits payments that simulation rejects anyway, so the
	// rejection is visible on-chain with a tx hash (costs a fee). Demo feature.
	RecordRejections bool
}

type Wallet struct {
	cfg  Config
	rpc  *rpcclient.Client
	http *http.Client
	// shared between ForAccount copies
	pool        chan *keypair.Full // free relayer channel accounts
	sourceLocks *sync.Map          // G address -> *sync.Mutex, for txs a user account is source of

	// State() costs ~6 RPC round trips; UI polling and tool calls share a
	// short-lived copy, dropped after every submitted transaction.
	stateMu sync.Mutex
	state   *State
	stateAt time.Time
}

const stateTTL = 5 * time.Second

func (w *Wallet) invalidate() {
	w.stateMu.Lock()
	w.state = nil
	w.stateMu.Unlock()
}

func New(cfg Config) *Wallet {
	hc := &http.Client{Timeout: 30 * time.Second}
	if len(cfg.Relayers) == 0 && cfg.Relayer != nil {
		cfg.Relayers = []*keypair.Full{cfg.Relayer}
	}
	if cfg.Relayer == nil && len(cfg.Relayers) > 0 {
		cfg.Relayer = cfg.Relayers[0]
	}
	pool := make(chan *keypair.Full, len(cfg.Relayers))
	for _, r := range cfg.Relayers {
		pool <- r
	}
	return &Wallet{cfg: cfg, rpc: rpcclient.NewClient(cfg.RPCURL, hc), http: hc, pool: pool, sourceLocks: &sync.Map{}}
}

// ForAccount returns a handle on another smart account that shares this
// wallet's RPC client, relayer pool and contracts. agent may be nil for
// owner-only use.
func (w *Wallet) ForAccount(account string, agentRule uint32, agent *keypair.Full) *Wallet {
	cfg := w.cfg
	cfg.SmartAccount, cfg.AgentRule, cfg.Agent = account, agentRule, agent
	return &Wallet{cfg: cfg, rpc: w.rpc, http: w.http, pool: w.pool, sourceLocks: w.sourceLocks}
}

// relayed assembles op with a free relayer from the pool as tx source and
// submits it. The relayer is held only for build + send + poll.
func (w *Wallet) relayed(ctx context.Context, op *txnbuild.InvokeHostFunction, auth []xdr.SorobanAuthorizationEntry, sim protocol.SimulateTransactionResponse, cpuBump float64) (*Tx, error) {
	var relayer *keypair.Full
	select {
	case relayer = <-w.pool:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { w.pool <- relayer }()
	op.SourceAccount = relayer.Address()
	ready, err := w.assemble(ctx, relayer, op, auth, sim, cpuBump)
	if err != nil {
		return nil, err
	}
	return w.submit(ctx, ready, relayer)
}

func (w *Wallet) lockSource(address string) func() {
	m, _ := w.sourceLocks.LoadOrStore(address, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func (w *Wallet) Config() Config { return w.cfg }

func (w *Wallet) TxURL(hash string) string { return w.cfg.Explorer + "/tx/" + hash }

// ---------------------------------------------------------------- errors

// Error is a structured failure meant to be shown to an LLM agent and a UI.
type Error struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
	Tx      *Tx            `json:"-"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func errf(code, format string, a ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, a...)}
}

// AsError converts any error into *Error.
func AsError(err error) *Error {
	if err == nil {
		return nil
	}
	var we *Error
	if errors.As(err, &we) {
		return we
	}
	return &Error{Code: "rpc_error", Message: err.Error()}
}

var contractErrRe = regexp.MustCompile(`Error\(Contract, #(\d+)\)|"contract":\s*(\d+)`)

// Known contract error codes (OZ stellar-accounts 0.8.0 and the SAC).
var contractErrors = map[int][2]string{
	3221: {"spending_limit_exceeded", "the payment exceeds the agent's spending limit (SpendingLimitExceeded #3221)"},
	3002: {"agent_inactive", "the agent's context rule is expired or revoked (UnvalidatedContext #3002)"},
	3005: {"invalid_argument", "valid_until is in the past (PastValidUntil #3005)"},
	3003: {"signature_invalid", "the signer's signature was rejected by the verifier (#3003)"},
	3016: {"signature_invalid", "the signer is not part of the selected context rule (#3016)"},
	3000: {"rule_not_found", "context rule not found (#3000)"},
	3220: {"policy_not_installed", "spending limit policy is not installed for this rule (#3220)"},
	3225: {"policy_already_installed", "spending limit policy is already installed (#3225)"},
	3222: {"invalid_argument", "invalid spending limit or period (#3222)"},
	10:   {"insufficient_balance", "the wallet balance is too low (SAC BalanceError #10)"},
	13:   {"payee_no_trustline", "the payee has no trustline for this asset (SAC TrustlineMissingError #13)"},
	8:    {"invalid_argument", "negative amount (SAC #8)"},
}

// classify picks the most specific known contract error in a host error dump.
func classify(text string) *Error {
	var first *Error
	for _, m := range contractErrRe.FindAllStringSubmatch(text, -1) {
		s := m[1]
		if s == "" {
			s = m[2]
		}
		code, _ := strconv.Atoi(s)
		if known, ok := contractErrors[code]; ok {
			e := &Error{Code: known[0], Message: known[1], Details: map[string]any{"contract_error": code}}
			// policy / account errors are more specific than wrapper errors
			if code >= 3000 {
				return e
			}
			if first == nil {
				first = e
			}
		} else if first == nil {
			first = &Error{Code: "contract_error", Message: fmt.Sprintf("contract error #%d", code), Details: map[string]any{"contract_error": code}}
		}
	}
	if first != nil {
		return first
	}
	line := strings.SplitN(text, "\n", 2)[0]
	return &Error{Code: "tx_failed", Message: line}
}

// ---------------------------------------------------------------- tx plumbing

type Tx struct {
	Hash   string `json:"hash"`
	URL    string `json:"url"`
	Status string `json:"status"` // SUCCESS | FAILED
	Ledger uint32 `json:"ledger,omitempty"`
	Error  *Error `json:"error,omitempty"`

	returnValue *xdr.ScVal
}

// ReturnValue is the contract call result of a successful transaction.
func (t *Tx) ReturnValue() *xdr.ScVal { return t.returnValue }

// retry runs a read-only RPC call up to 3 times on transport errors (the
// public testnet RPC drops or stalls requests now and then).
func retry[T any](ctx context.Context, f func() (T, error)) (T, error) {
	var v T
	var err error
	for i := 0; i < 3; i++ {
		if v, err = f(); err == nil || ctx.Err() != nil {
			return v, err
		}
		select {
		case <-time.After(time.Duration(i+1) * 700 * time.Millisecond):
		case <-ctx.Done():
			return v, ctx.Err()
		}
	}
	return v, err
}

func (w *Wallet) LatestLedger(ctx context.Context) (uint32, error) {
	r, err := retry(ctx, func() (protocol.GetLatestLedgerResponse, error) { return w.rpc.GetLatestLedger(ctx) })
	if err != nil {
		return 0, err
	}
	return r.Sequence, nil
}

func (w *Wallet) invokeOp(source, contract, fn string, args []xdr.ScVal) (*txnbuild.InvokeHostFunction, error) {
	addr, err := sv.ScAddress(contract)
	if err != nil {
		return nil, err
	}
	return &txnbuild.InvokeHostFunction{
		HostFunction: xdr.HostFunction{
			Type: xdr.HostFunctionTypeHostFunctionTypeInvokeContract,
			InvokeContract: &xdr.InvokeContractArgs{
				ContractAddress: addr,
				FunctionName:    xdr.ScSymbol(fn),
				Args:            args,
			},
		},
		SourceAccount: source,
	}, nil
}

func (w *Wallet) build(ctx context.Context, source *keypair.Full, ops ...txnbuild.Operation) (*txnbuild.Transaction, error) {
	acct, err := retry(ctx, func() (txnbuild.Account, error) { return w.rpc.LoadAccount(ctx, source.Address()) })
	if err != nil {
		return nil, fmt.Errorf("load account %s: %w", source.Address(), err)
	}
	return txnbuild.NewTransaction(txnbuild.TransactionParams{
		SourceAccount:        acct,
		IncrementSequenceNum: true,
		Operations:           ops,
		BaseFee:              txnbuild.MinBaseFee,
		Preconditions:        txnbuild.Preconditions{TimeBounds: txnbuild.NewTimeout(300)},
	})
}

// buildSim builds a tx for simulation only. Simulation ignores the sequence
// number, so this skips the account lookup round trip.
func (w *Wallet) buildSim(source *keypair.Full, ops ...txnbuild.Operation) (*txnbuild.Transaction, error) {
	return txnbuild.NewTransaction(txnbuild.TransactionParams{
		SourceAccount:        &txnbuild.SimpleAccount{AccountID: source.Address(), Sequence: 0},
		IncrementSequenceNum: true,
		Operations:           ops,
		BaseFee:              txnbuild.MinBaseFee,
		Preconditions:        txnbuild.Preconditions{TimeBounds: txnbuild.NewTimeout(300)},
	})
}

func (w *Wallet) simulate(ctx context.Context, tx *txnbuild.Transaction, authMode string) (protocol.SimulateTransactionResponse, error) {
	b64, err := tx.Base64()
	if err != nil {
		return protocol.SimulateTransactionResponse{}, err
	}
	// contract errors come back in sim.Error, not err: only transport
	// failures are retried, and simulation never changes state
	return retry(ctx, func() (protocol.SimulateTransactionResponse, error) {
		return w.rpc.SimulateTransaction(ctx, protocol.SimulateTransactionRequest{
			Transaction:     b64,
			AuthMode:        authMode,
			UseUpgradedAuth: true,
		})
	})
}

// Call runs a read-only contract call via simulation.
func (w *Wallet) Call(ctx context.Context, contract, fn string, args ...xdr.ScVal) (xdr.ScVal, error) {
	op, err := w.invokeOp(w.cfg.Relayer.Address(), contract, fn, args)
	if err != nil {
		return xdr.ScVal{}, err
	}
	tx, err := w.buildSim(w.cfg.Relayer, op)
	if err != nil {
		return xdr.ScVal{}, err
	}
	sim, err := w.simulate(ctx, tx, "")
	if err != nil {
		return xdr.ScVal{}, err
	}
	if sim.Error != "" {
		return xdr.ScVal{}, classify(sim.Error)
	}
	if len(sim.Results) == 0 || sim.Results[0].ReturnValueXDR == nil {
		return xdr.ScVal{}, fmt.Errorf("%s.%s: no return value", contract, fn)
	}
	var v xdr.ScVal
	if err := xdr.SafeUnmarshalBase64(*sim.Results[0].ReturnValueXDR, &v); err != nil {
		return xdr.ScVal{}, err
	}
	return v, nil
}

func decodeAuth(sim protocol.SimulateTransactionResponse) ([]xdr.SorobanAuthorizationEntry, error) {
	if len(sim.Results) == 0 || sim.Results[0].AuthXDR == nil {
		return nil, nil
	}
	out := make([]xdr.SorobanAuthorizationEntry, 0, len(*sim.Results[0].AuthXDR))
	for _, b64 := range *sim.Results[0].AuthXDR {
		var e xdr.SorobanAuthorizationEntry
		if err := xdr.SafeUnmarshalBase64(b64, &e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

// assemble rebuilds the tx with auth entries and the simulated soroban data.
func (w *Wallet) assemble(ctx context.Context, source *keypair.Full, op *txnbuild.InvokeHostFunction, auth []xdr.SorobanAuthorizationEntry, sim protocol.SimulateTransactionResponse, cpuBump float64) (*txnbuild.Transaction, error) {
	var data xdr.SorobanTransactionData
	if err := xdr.SafeUnmarshalBase64(sim.TransactionDataXDR, &data); err != nil {
		return nil, fmt.Errorf("decode transactionData: %w", err)
	}
	if cpuBump > 1 {
		data.Resources.Instructions = xdr.Uint32(float64(data.Resources.Instructions) * cpuBump)
	}
	// 30% headroom over the simulated resource fee; unused fee is refunded
	data.ResourceFee = xdr.Int64(sim.MinResourceFee*13/10 + 1000)
	op.Auth = auth
	op.Ext = xdr.TransactionExt{V: 1, SorobanData: &data}
	return w.build(ctx, source, op)
}

// submit signs, sends and polls a transaction.
func (w *Wallet) submit(ctx context.Context, tx *txnbuild.Transaction, signers ...*keypair.Full) (*Tx, error) {
	tx, err := tx.Sign(w.cfg.Passphrase, signers...)
	if err != nil {
		return nil, err
	}
	hash, err := tx.HashHex(w.cfg.Passphrase)
	if err != nil {
		return nil, err
	}
	b64, err := tx.Base64()
	if err != nil {
		return nil, err
	}
	defer w.invalidate()
	sent, err := w.rpc.SendTransaction(ctx, protocol.SendTransactionRequest{Transaction: b64})
	if err != nil {
		return nil, fmt.Errorf("sendTransaction: %w", err)
	}
	if sent.Status == "ERROR" {
		msg := sent.ErrorResultXDR
		var res xdr.TransactionResult
		if xdr.SafeUnmarshalBase64(sent.ErrorResultXDR, &res) == nil {
			msg = res.Result.Code.String()
		}
		return nil, &Error{Code: "tx_rejected", Message: "RPC rejected the transaction: " + msg}
	}
	pctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	got, err := w.rpc.PollTransaction(pctx, hash)
	if err != nil {
		return nil, fmt.Errorf("poll %s: %w", hash, err)
	}
	out := &Tx{Hash: hash, URL: w.TxURL(hash), Status: got.Status, Ledger: got.Ledger}
	if got.Status != protocol.TransactionStatusSuccess {
		out.Status = "FAILED"
		out.Error = w.describeFailure(ctx, hash)
		return out, nil
	}
	var meta xdr.TransactionMeta
	if got.ResultMetaXDR != "" && xdr.SafeUnmarshalBase64(got.ResultMetaXDR, &meta) == nil {
		if rv, ok := returnValue(meta); ok {
			out.returnValue = &rv
		}
	}
	return out, nil
}

func returnValue(meta xdr.TransactionMeta) (xdr.ScVal, bool) {
	switch {
	case meta.V4 != nil && meta.V4.SorobanMeta != nil && meta.V4.SorobanMeta.ReturnValue != nil:
		return *meta.V4.SorobanMeta.ReturnValue, true
	case meta.V3 != nil && meta.V3.SorobanMeta != nil:
		return meta.V3.SorobanMeta.ReturnValue, true
	}
	return xdr.ScVal{}, false
}

// describeFailure fetches a failed tx with JSON XDR and classifies its
// diagnostic events.
func (w *Wallet) describeFailure(ctx context.Context, hash string) *Error {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "getTransaction",
		"params": map[string]any{"hash": hash, "xdrFormat": "json"},
	})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, w.cfg.RPCURL, strings.NewReader(string(body)))
	req.Header.Set("content-type", "application/json")
	resp, err := w.http.Do(req)
	if err != nil {
		return &Error{Code: "tx_failed", Message: "transaction failed (could not fetch details: " + err.Error() + ")"}
	}
	defer resp.Body.Close()
	var r struct {
		Result struct {
			ResultJSON json.RawMessage   `json:"resultJson"`
			Events     []json.RawMessage `json:"diagnosticEventsJson"`
		} `json:"result"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&r)
	var sb strings.Builder
	for _, ev := range r.Result.Events {
		sb.Write(ev)
		sb.WriteByte('\n')
	}
	e := classify(sb.String())
	if e.Code == "tx_failed" {
		e.Message = "transaction failed: " + string(r.Result.ResultJSON)
	}
	return e
}

// ---------------------------------------------------------------- smart account auth

func addressCreds(c *xdr.SorobanCredentials) *xdr.SorobanAddressCredentials {
	switch c.Type {
	case xdr.SorobanCredentialsTypeSorobanCredentialsAddress:
		return c.Address
	case xdr.SorobanCredentialsTypeSorobanCredentialsAddressV2:
		return c.AddressV2
	case xdr.SorobanCredentialsTypeSorobanCredentialsAddressWithDelegates:
		return &c.AddressWithDelegates.AddressCredentials
	}
	return nil
}

func countInvocations(inv xdr.SorobanAuthorizedInvocation) int {
	n := 1
	for _, sub := range inv.SubInvocations {
		n += countInvocations(sub)
	}
	return n
}

// signaturePayload is the hash the host passes to __check_auth.
func (w *Wallet) signaturePayload(entry xdr.SorobanAuthorizationEntry, c *xdr.SorobanAddressCredentials) ([32]byte, error) {
	netID := xdr.Hash(network.ID(w.cfg.Passphrase))
	var pre xdr.HashIdPreimage
	if entry.Credentials.Type == xdr.SorobanCredentialsTypeSorobanCredentialsAddress {
		pre = xdr.HashIdPreimage{
			Type: xdr.EnvelopeTypeEnvelopeTypeSorobanAuthorization,
			SorobanAuthorization: &xdr.HashIdPreimageSorobanAuthorization{
				NetworkId: netID, Nonce: c.Nonce,
				SignatureExpirationLedger: c.SignatureExpirationLedger,
				Invocation:                entry.RootInvocation,
			},
		}
	} else {
		// CAP-71: v2 / with-delegates credentials bind the address into the payload
		pre = xdr.HashIdPreimage{
			Type: xdr.EnvelopeTypeEnvelopeTypeSorobanAuthorizationWithAddress,
			SorobanAuthorizationWithAddress: &xdr.HashIdPreimageSorobanAuthorizationWithAddress{
				NetworkId: netID, Nonce: c.Nonce,
				SignatureExpirationLedger: c.SignatureExpirationLedger,
				Address:                   c.Address,
				Invocation:                entry.RootInvocation,
			},
		}
	}
	raw, err := pre.MarshalBinary()
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(raw), nil
}

// ExternalSigner encodes Signer::External(verifier, ed25519 public key).
func (w *Wallet) ExternalSigner(kp keypair.KP) xdr.ScVal {
	raw, _ := rawPublicKey(kp.Address())
	return sv.Enum("External", sv.MustAddr(w.cfg.Verifier), sv.Bytes(raw))
}

// signEntries signs every auth entry that belongs to the smart account.
func (w *Wallet) signEntries(entries []xdr.SorobanAuthorizationEntry, signer *keypair.Full, ruleID uint32, expiration uint32, nonce *xdr.Int64) ([]xdr.SorobanAuthorizationEntry, error) {
	account, err := sv.ScAddress(w.cfg.SmartAccount)
	if err != nil {
		return nil, err
	}
	out := make([]xdr.SorobanAuthorizationEntry, 0, len(entries))
	for _, entry := range entries {
		c := addressCreds(&entry.Credentials)
		if c == nil || !c.Address.Equals(account) {
			out = append(out, entry)
			continue
		}
		if nonce != nil {
			c.Nonce = *nonce
		}
		c.SignatureExpirationLedger = xdr.Uint32(expiration)
		payload, err := w.signaturePayload(entry, c)
		if err != nil {
			return nil, err
		}
		// one rule id per auth context (root + every sub-invocation)
		ids := make([]xdr.ScVal, countInvocations(entry.RootInvocation))
		for i := range ids {
			ids[i] = sv.U32(ruleID)
		}
		preimage := sv.Struct(map[string]xdr.ScVal{
			"account":           sv.MustAddr(w.cfg.SmartAccount),
			"context_rule_ids":  sv.Vec(ids...),
			"signature_payload": sv.Bytes(payload[:]),
		})
		raw, err := preimage.MarshalBinary()
		if err != nil {
			return nil, err
		}
		digest := sha256.Sum256(raw)
		sig, err := signer.Sign(digest[:])
		if err != nil {
			return nil, err
		}
		c.Signature = sv.Struct(map[string]xdr.ScVal{
			"context_rule_ids": sv.Vec(ids...),
			"signers":          sv.Map(xdr.ScMapEntry{Key: w.ExternalSigner(signer), Val: sv.Bytes(sig)}),
		})
		out = append(out, entry)
	}
	return out, nil
}

func cloneEntries(in []xdr.SorobanAuthorizationEntry) []xdr.SorobanAuthorizationEntry {
	out := make([]xdr.SorobanAuthorizationEntry, len(in))
	for i, e := range in {
		raw, _ := e.MarshalBinary()
		_ = out[i].UnmarshalBinary(raw)
	}
	return out
}

// InvokeAsAccount calls contract.fn(args) with the smart account as the
// authorizer, signed by `signer` under context rule `ruleID`. The relayer
// pays the fee.
//
// When simulation rejects the call: with probeArgs set and RecordRejections
// on, the call is still submitted using the footprint of a passing probe
// call over the same ledger keys, so the rejection gets an on-chain tx.
func (w *Wallet) InvokeAsAccount(ctx context.Context, signer *keypair.Full, ruleID uint32, contract, fn string, args, probeArgs []xdr.ScVal) (*Tx, *Error) {

	newOp := func(a []xdr.ScVal) (*txnbuild.InvokeHostFunction, error) {
		return w.invokeOp(w.cfg.Relayer.Address(), contract, fn, a)
	}
	record := func(a []xdr.ScVal) ([]xdr.SorobanAuthorizationEntry, error) {
		op, err := newOp(a)
		if err != nil {
			return nil, err
		}
		tx, err := w.buildSim(w.cfg.Relayer, op)
		if err != nil {
			return nil, err
		}
		sim, err := w.simulate(ctx, tx, "record")
		if err != nil {
			return nil, err
		}
		if sim.Error != "" {
			return nil, classify(sim.Error)
		}
		return decodeAuth(sim)
	}
	latest, err := w.LatestLedger(ctx)
	if err != nil {
		return nil, AsError(err)
	}
	expiration := latest + 100

	// 1) recording simulation: auth entries (nonce + invocation tree)
	recorded, err := record(args)
	if err != nil {
		return nil, AsError(err)
	}
	var nonce *xdr.Int64
	for _, e := range recorded {
		if c := addressCreds(&e.Credentials); c != nil {
			n := c.Nonce
			nonce = &n
			break
		}
	}
	signed, err := w.signEntries(cloneEntries(recorded), signer, ruleID, expiration, nil)
	if err != nil {
		return nil, AsError(err)
	}

	// 2) enforcing simulation: runs __check_auth, signature, rule and policies
	op, err := newOp(args)
	if err != nil {
		return nil, AsError(err)
	}
	op.Auth = signed
	tx, err := w.buildSim(w.cfg.Relayer, op)
	if err != nil {
		return nil, AsError(err)
	}
	sim, err := w.simulate(ctx, tx, "enforce")
	if err != nil {
		return nil, AsError(err)
	}
	if sim.Error == "" {
		op, _ = newOp(args)
		res, err := w.relayed(ctx, op, signed, sim, 1)
		if err != nil {
			return nil, AsError(err)
		}
		if res.Status != "SUCCESS" {
			res.Error.Tx = res
			return res, res.Error
		}
		return res, nil
	}

	rejection := classify(sim.Error)
	rejection.Details = mergeDetails(rejection.Details, map[string]any{"simulation": firstLine(sim.Error)})
	if probeArgs == nil || !w.cfg.RecordRejections {
		return nil, rejection
	}

	// 3) record the rejection on-chain: footprint from a passing probe call
	probeRec, err := record(probeArgs)
	if err != nil {
		return nil, rejection
	}
	probeSigned, err := w.signEntries(probeRec, signer, ruleID, expiration, nonce)
	if err != nil {
		return nil, rejection
	}
	pop, _ := newOp(probeArgs)
	pop.Auth = probeSigned
	ptx, err := w.buildSim(w.cfg.Relayer, pop)
	if err != nil {
		return nil, rejection
	}
	psim, err := w.simulate(ctx, ptx, "enforce")
	if err != nil || psim.Error != "" {
		return nil, rejection
	}
	op, _ = newOp(args)
	res, err := w.relayed(ctx, op, signed, psim, 1.5)
	if err != nil {
		return nil, rejection
	}
	if res.Status == "SUCCESS" {
		// should not happen: simulation rejected it
		return res, nil
	}
	if res.Error != nil && res.Error.Code == rejection.Code {
		res.Error.Details = mergeDetails(res.Error.Details, rejection.Details)
	}
	rejection.Tx = res
	res.Error = rejection
	return res, rejection
}

// InvokeAsSource calls a contract with a classic G account as tx source and
// authorizer (source-account auth).
func (w *Wallet) InvokeAsSource(ctx context.Context, source *keypair.Full, contract, fn string, args []xdr.ScVal) (*Tx, *Error) {
	defer w.lockSource(source.Address())()
	op, err := w.invokeOp(source.Address(), contract, fn, args)
	if err != nil {
		return nil, AsError(err)
	}
	tx, err := w.build(ctx, source, op)
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
	op, _ = w.invokeOp(source.Address(), contract, fn, args)
	ready, err := w.assemble(ctx, source, op, auth, sim, 1)
	if err != nil {
		return nil, AsError(err)
	}
	res, err := w.submit(ctx, ready, source)
	if err != nil {
		return nil, AsError(err)
	}
	if res.Status != "SUCCESS" {
		res.Error.Tx = res
		return res, res.Error
	}
	return res, nil
}

// Classic submits classic operations from source.
func (w *Wallet) Classic(ctx context.Context, source *keypair.Full, ops ...txnbuild.Operation) (*Tx, *Error) {
	defer w.lockSource(source.Address())()
	tx, err := w.build(ctx, source, ops...)
	if err != nil {
		return nil, AsError(err)
	}
	res, err := w.submit(ctx, tx, source)
	if err != nil {
		return nil, AsError(err)
	}
	if res.Status != "SUCCESS" {
		res.Error.Tx = res
		return res, res.Error
	}
	return res, nil
}

func mergeDetails(a, b map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

func firstLine(s string) string { return strings.SplitN(s, "\n", 2)[0] }

func i128(v xdr.ScVal) *big.Int {
	if n, ok := sv.Native(v).(*big.Int); ok {
		return n
	}
	return new(big.Int)
}
