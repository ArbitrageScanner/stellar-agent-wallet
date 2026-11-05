package wallet

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/xdr"

	sv "github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/stellar"
)

// LedgerSeconds is the average testnet ledger close time used for estimates.
const LedgerSeconds = 5

func rawPublicKey(g string) ([]byte, error) { return strkey.Decode(strkey.VersionByteAccountID, g) }

// ---------------------------------------------------------------- reads

func (w *Wallet) Balance(ctx context.Context, address string) (*big.Int, error) {
	a, err := sv.Addr(address)
	if err != nil {
		return nil, err
	}
	v, err := w.Call(ctx, w.cfg.USDC, "balance", a)
	if err != nil {
		return nil, err
	}
	return i128(v), nil
}

type Signer struct {
	Kind     string  `json:"kind"`
	Verifier *string `json:"verifier"`
	Key      string  `json:"key"`
}

type Rule struct {
	ID          uint32   `json:"id"`
	Name        string   `json:"name"`
	ContextType string   `json:"context_type"`
	Target      *string  `json:"target"`
	Signers     []Signer `json:"signers"`
	Policies    []string `json:"policies"`
	ValidUntil  *uint32  `json:"valid_until"`

	raw xdr.ScVal
}

func parseRule(v xdr.ScVal) Rule {
	n, _ := sv.Native(v).(map[string]any)
	r := Rule{raw: v, Signers: []Signer{}, Policies: []string{}}
	r.ID, _ = n["id"].(uint32)
	r.Name, _ = n["name"].(string)
	if ct, ok := n["context_type"].([]any); ok && len(ct) > 0 {
		r.ContextType, _ = ct[0].(string)
		if len(ct) > 1 {
			t := fmt.Sprint(ct[1])
			r.Target = &t
		}
	}
	if vu, ok := n["valid_until"].(uint32); ok {
		r.ValidUntil = &vu
	}
	if ps, ok := n["policies"].([]any); ok {
		for _, p := range ps {
			r.Policies = append(r.Policies, fmt.Sprint(p))
		}
	}
	if ss, ok := n["signers"].([]any); ok {
		for _, s := range ss {
			parts, _ := s.([]any)
			if len(parts) == 0 {
				continue
			}
			sg := Signer{Kind: fmt.Sprint(parts[0])}
			switch {
			case sg.Kind == "External" && len(parts) == 3:
				v := fmt.Sprint(parts[1])
				sg.Verifier = &v
				sg.Key = fmt.Sprint(parts[2])
			case len(parts) == 2:
				sg.Key = fmt.Sprint(parts[1])
			}
			r.Signers = append(r.Signers, sg)
		}
	}
	return r
}

func (w *Wallet) Rule(ctx context.Context, id uint32) (Rule, error) {
	v, err := w.Call(ctx, w.cfg.SmartAccount, "get_context_rule", sv.U32(id))
	if err != nil {
		return Rule{}, err
	}
	return parseRule(v), nil
}

func (w *Wallet) Rules(ctx context.Context) ([]Rule, error) {
	// ids are sequential and removed rules leave gaps. Fetch the count and the
	// first few ids in one parallel round, then whatever is still missing.
	const guess = 4
	rules := make([]*Rule, guess)
	var wg sync.WaitGroup
	fetch := func(id int) {
		defer wg.Done()
		if r, err := w.Rule(ctx, uint32(id)); err == nil {
			rules[id] = &r
		}
	}
	var count uint32
	var countErr error
	wg.Add(1 + guess)
	go func() {
		defer wg.Done()
		cv, err := w.Call(ctx, w.cfg.SmartAccount, "get_context_rules_count")
		if countErr = err; err == nil {
			count, _ = sv.Native(cv).(uint32)
		}
	}()
	for id := 0; id < guess; id++ {
		go fetch(id)
	}
	wg.Wait()
	if countErr != nil {
		return nil, countErr
	}
	if n := int(count) + 2; n > guess {
		rules = append(rules, make([]*Rule, n-guess)...)
		wg.Add(n - guess)
		for id := guess; id < n; id++ {
			go fetch(id)
		}
		wg.Wait()
	}
	var out []Rule
	for _, r := range rules {
		if r != nil && uint32(len(out)) < count {
			out = append(out, *r)
		}
	}
	return out, nil
}

type SpendEntry struct {
	Amount string `json:"amount"`
	Ledger uint32 `json:"ledger"`
}

type Limit struct {
	Installed       bool         `json:"installed"`
	Limit           *string      `json:"limit"`
	Spent           *string      `json:"spent"`
	Remaining       *string      `json:"remaining"`
	PeriodLedgers   *uint32      `json:"period_ledgers"`
	ResetsInSeconds *int64       `json:"resets_in_seconds"`
	History         []SpendEntry `json:"history"`

	limit, spent, remaining *big.Int
}

// spendingData reads the raw policy state for the agent rule; nil when the
// policy is not installed for it.
func (w *Wallet) spendingData(ctx context.Context) (map[string]any, error) {
	v, err := w.Call(ctx, w.cfg.Policy, "get_spending_limit_data", sv.U32(w.cfg.AgentRule), sv.MustAddr(w.cfg.SmartAccount))
	if err != nil {
		if e := AsError(err); e.Code == "policy_not_installed" {
			return nil, nil
		}
		return nil, err
	}
	n, _ := sv.Native(v).(map[string]any)
	return n, nil
}

// computeLimit recomputes the rolling window the same way the policy does
// (entries at or before latest - period_ledgers drop out).
func computeLimit(n map[string]any, latest uint32) (Limit, error) {
	out := Limit{History: []SpendEntry{}}
	if n == nil {
		return out, nil
	}
	limit, _ := n["spending_limit"].(*big.Int)
	period, _ := n["period_ledgers"].(uint32)
	if limit == nil {
		return out, fmt.Errorf("unexpected spending limit data: %v", n)
	}
	cutoff := uint32(0)
	if latest > period {
		cutoff = latest - period
	}
	spent := new(big.Int)
	var oldest *uint32
	hist, _ := n["spending_history"].([]any)
	for _, h := range hist {
		e, _ := h.(map[string]any)
		amt, _ := e["amount"].(*big.Int)
		seq, _ := e["ledger_sequence"].(uint32)
		if amt == nil || seq <= cutoff {
			continue
		}
		spent.Add(spent, amt)
		if oldest == nil {
			s := seq
			oldest = &s
		}
		out.History = append(out.History, SpendEntry{Amount: sv.FormatAmount(amt), Ledger: seq})
	}
	remaining := new(big.Int).Sub(limit, spent)
	if remaining.Sign() < 0 {
		remaining.SetInt64(0)
	}
	out.Installed = true
	out.limit, out.spent, out.remaining = limit, spent, remaining
	l, s, r := sv.FormatAmount(limit), sv.FormatAmount(spent), sv.FormatAmount(remaining)
	out.Limit, out.Spent, out.Remaining, out.PeriodLedgers = &l, &s, &r, &period
	if oldest != nil {
		secs := int64(*oldest+period-latest) * LedgerSeconds
		if secs < 0 {
			secs = 0
		}
		out.ResetsInSeconds = &secs
	}
	return out, nil
}

type AgentStatus struct {
	PublicKey  string  `json:"public_key"`
	RuleID     uint32  `json:"rule_id"`
	Active     bool    `json:"active"`
	ValidUntil *uint32 `json:"valid_until"`
}

type State struct {
	Address      string      `json:"address"`
	URL          string      `json:"url"`
	Balances     []Balance   `json:"balances"`
	Limit        Limit       `json:"limit"`
	Agent        AgentStatus `json:"agent"`
	Rules        []Rule      `json:"rules"`
	LatestLedger uint32      `json:"latest_ledger"`
}

type Balance struct {
	Asset    string `json:"asset"`
	Contract string `json:"contract"`
	Amount   string `json:"amount"`
}

// State returns the wallet state, from a cache younger than stateTTL when
// possible. The reads run in parallel: testnet RPC round trips are slow.
func (w *Wallet) State(ctx context.Context) (State, error) {
	w.stateMu.Lock()
	defer w.stateMu.Unlock()
	if w.state != nil && time.Since(w.stateAt) < stateTTL {
		return *w.state, nil
	}

	var (
		wg                                  sync.WaitGroup
		latest                              uint32
		bal                                 *big.Int
		rules                               []Rule
		data                                map[string]any
		errLatest, errBal, errRules, errLim error
	)
	wg.Add(4)
	go func() { defer wg.Done(); latest, errLatest = w.LatestLedger(ctx) }()
	go func() { defer wg.Done(); bal, errBal = w.Balance(ctx, w.cfg.SmartAccount) }()
	go func() { defer wg.Done(); rules, errRules = w.Rules(ctx) }()
	go func() { defer wg.Done(); data, errLim = w.spendingData(ctx) }()
	wg.Wait()
	if err := errors.Join(errLatest, errBal, errRules, errLim); err != nil {
		return State{}, err
	}

	st := State{
		Address:      w.cfg.SmartAccount,
		URL:          w.cfg.Explorer + "/contract/" + w.cfg.SmartAccount,
		Balances:     []Balance{{Asset: "USDC", Contract: w.cfg.USDC, Amount: sv.FormatAmount(bal)}},
		Limit:        Limit{History: []SpendEntry{}},
		Rules:        rules,
		LatestLedger: latest,
		Agent:        AgentStatus{PublicKey: w.cfg.Agent.Address(), RuleID: w.cfg.AgentRule},
	}
	for _, r := range rules {
		if r.ID != w.cfg.AgentRule {
			continue
		}
		st.Agent.ValidUntil = r.ValidUntil
		st.Agent.Active = r.ValidUntil == nil || *r.ValidUntil >= latest
		// the policy keeps its data after removal only if never uninstalled;
		// trust the rule's policy list
		for _, p := range r.Policies {
			if p == w.cfg.Policy {
				l, err := computeLimit(data, latest)
				if err != nil {
					return State{}, err
				}
				st.Limit = l
			}
		}
	}
	w.state, w.stateAt = &st, time.Now()
	return st, nil
}

// ---------------------------------------------------------------- payments

func (w *Wallet) validatePayee(to string) *Error {
	if !strkey.IsValidEd25519PublicKey(to) && !strkey.IsValidContractAddress(to) {
		return errf("invalid_argument", "payee %q is not a valid G… or C… address", to)
	}
	if to == w.cfg.SmartAccount {
		return errf("invalid_argument", "payee is the wallet itself")
	}
	return nil
}

// Precheck reports, without touching the chain's state, why a payment would
// fail (balance, limit, revoked agent). nil means it should go through.
func (w *Wallet) Precheck(ctx context.Context, to string, amount *big.Int) (*State, *Error) {
	if e := w.validatePayee(to); e != nil {
		return nil, e
	}
	if amount.Sign() <= 0 {
		return nil, errf("invalid_argument", "amount must be positive")
	}
	st, err := w.State(ctx)
	if err != nil {
		return nil, AsError(err)
	}
	if !st.Agent.Active {
		return &st, errf("agent_inactive", "the agent's access was revoked by the owner (rule #%d expired at ledger %d)", w.cfg.AgentRule, *st.Agent.ValidUntil)
	}
	bal, _ := sv.ParseAmount(st.Balances[0].Amount)
	if bal.Cmp(amount) < 0 {
		return &st, &Error{Code: "insufficient_balance", Message: "the wallet balance is too low",
			Details: map[string]any{"balance": st.Balances[0].Amount, "requested": sv.FormatAmount(amount)}}
	}
	if st.Limit.Installed && new(big.Int).Add(st.Limit.spent, amount).Cmp(st.Limit.limit) > 0 {
		return &st, w.limitError(st.Limit, amount)
	}
	return &st, nil
}

func (w *Wallet) limitError(l Limit, amount *big.Int) *Error {
	d := map[string]any{"requested": sv.FormatAmount(amount)}
	if l.Installed {
		d["limit"], d["spent"], d["remaining"] = *l.Limit, *l.Spent, *l.Remaining
		d["period_ledgers"] = *l.PeriodLedgers
		if l.ResetsInSeconds != nil {
			d["resets_in_seconds"] = *l.ResetsInSeconds
		}
	}
	return &Error{Code: "spending_limit_exceeded",
		Message: "the payment exceeds the agent's spending limit (policy error SpendingLimitExceeded #3221)", Details: d}
}

func (w *Wallet) transferArgs(to string, amount *big.Int) ([]xdr.ScVal, error) {
	toVal, err := sv.Addr(to)
	if err != nil {
		return nil, err
	}
	return []xdr.ScVal{sv.MustAddr(w.cfg.SmartAccount), toVal, sv.I128(amount)}, nil
}

// SimulatePayment runs the agent's transfer through enforcing simulation
// (signature, context rule, spending-limit policy) without submitting it.
func (w *Wallet) SimulatePayment(ctx context.Context, to string, amount *big.Int) (map[string]any, *Error) {
	st, pe := w.Precheck(ctx, to, amount)
	if pe != nil && pe.Code != "spending_limit_exceeded" {
		return nil, pe
	}
	res := map[string]any{"to": to, "amount": sv.FormatAmount(amount), "asset": "USDC"}
	if st != nil && st.Limit.Installed {
		res["remaining_before"] = *st.Limit.Remaining
		after := new(big.Int).Sub(st.Limit.remaining, amount)
		if after.Sign() >= 0 {
			res["remaining_after"] = sv.FormatAmount(after)
		}
	}
	args, err := w.transferArgs(to, amount)
	if err != nil {
		return nil, errf("invalid_argument", "%v", err)
	}
	if e := w.simulateOnly(ctx, args); e != nil {
		if e.Code == "spending_limit_exceeded" && st != nil {
			e = w.limitError(st.Limit, amount)
		}
		res["would_succeed"] = false
		res["error"] = e
		return res, nil
	}
	res["would_succeed"] = true
	return res, nil
}

func (w *Wallet) simulateOnly(ctx context.Context, args []xdr.ScVal) *Error {
	op, err := w.invokeOp(w.cfg.Relayer.Address(), w.cfg.USDC, "transfer", args)
	if err != nil {
		return AsError(err)
	}
	tx, err := w.buildSim(w.cfg.Relayer, op)
	if err != nil {
		return AsError(err)
	}
	sim, err := w.simulate(ctx, tx, "record")
	if err != nil {
		return AsError(err)
	}
	if sim.Error != "" {
		return classify(sim.Error)
	}
	auth, err := decodeAuth(sim)
	if err != nil {
		return AsError(err)
	}
	latest, err := w.LatestLedger(ctx)
	if err != nil {
		return AsError(err)
	}
	signed, err := w.signEntries(auth, w.cfg.Agent, w.cfg.AgentRule, latest+100, nil)
	if err != nil {
		return AsError(err)
	}
	op, _ = w.invokeOp(w.cfg.Relayer.Address(), w.cfg.USDC, "transfer", args)
	op.Auth = signed
	tx, err = w.buildSim(w.cfg.Relayer, op)
	if err != nil {
		return AsError(err)
	}
	sim, err = w.simulate(ctx, tx, "enforce")
	if err != nil {
		return AsError(err)
	}
	if sim.Error != "" {
		return classify(sim.Error)
	}
	return nil
}

// Pay sends USDC from the smart account, signed by the agent key under the
// agent rule. Balance and revocation are prechecked; the spending limit is
// always left to the on-chain policy (a precheck hit only enriches the error).
func (w *Wallet) Pay(ctx context.Context, to string, amount *big.Int) (*Tx, *Error) {
	st, pe := w.Precheck(ctx, to, amount)
	if pe != nil && pe.Code != "spending_limit_exceeded" {
		return nil, pe
	}
	args, err := w.transferArgs(to, amount)
	if err != nil {
		return nil, errf("invalid_argument", "%v", err)
	}
	// probe: same accounts and policy keys, zero amount -> always passes the policy
	probe, _ := w.transferArgs(to, new(big.Int))
	tx, e := w.InvokeAsAccount(ctx, w.cfg.Agent, w.cfg.AgentRule, w.cfg.USDC, "transfer", args, probe)
	if e != nil && e.Code == "spending_limit_exceeded" && st != nil {
		enriched := w.limitError(st.Limit, amount)
		enriched.Tx = e.Tx
		if tx != nil {
			tx.Error = enriched
		}
		return tx, enriched
	}
	return tx, e
}
