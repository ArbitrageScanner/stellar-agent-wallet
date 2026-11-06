// Package tools is the single set of wallet tools exposed to agents, both to
// the built-in chat (in-process) and to external agents over MCP.
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"

	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/db"
	sv "github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/stellar"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/wallet"
)

type Tool struct {
	Name        string
	Description string
	Schema      map[string]any
}

// Approval is what a human is asked to confirm before a payment goes out.
type Approval struct {
	Summary string `json:"summary"`
	To      string `json:"to"`
	Amount  string `json:"amount"`
	Asset   string `json:"asset"`
}

// Approver asks a human. It returns false when the person declines.
type Approver func(ctx context.Context, a Approval) (bool, error)

// Result is what a tool call returns.
type Result struct {
	OK     bool          `json:"ok"`
	Data   any           `json:"result"`
	Error  *wallet.Error `json:"error"`
	Txs    []*wallet.Tx  `json:"-"`
	Pretty string        `json:"-"`
}

// JSON is the payload handed back to the model.
func (r Result) JSON() string {
	var v any
	if r.OK {
		v = r.Data
	} else {
		v = map[string]any{"error": r.Error}
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// Log is the agent-scoped payment log.
type Log interface {
	Add(p db.Payment) error
	Recent(n int) []db.Payment
	ByIdempotencyKey(key string) (db.Payment, bool)
}

// Registry is the tool set of one agent: W is a wallet handle on the
// owner's smart account with the agent's key and rule.
type Registry struct {
	W         *wallet.Wallet
	Log       Log
	AgentID   string
	Threshold *big.Int    // payments above this need human approval
	PayMu     *sync.Mutex // per agent: serializes idempotency + limit checks
}

func (r *Registry) Tools() []Tool {
	addr := map[string]any{"type": "string", "description": "Payee Stellar address: G… account (needs a USDC trustline) or C… contract"}
	amount := map[string]any{"type": "string", "description": "Amount of USDC as a decimal string, e.g. \"1\" or \"0.25\" (max 7 decimals)"}
	return []Tool{
		{
			Name: "wallet_info",
			Description: "Get the agent wallet: address, USDC balance, spending limit (limit, spent and remaining in the " +
				"current ~24h window, time until it resets), and whether the agent's access is active. Call this before paying " +
				"when you are unsure about the balance or limit.",
			Schema: map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false},
		},
		{
			Name: "simulate_payment",
			Description: "Dry-run a USDC payment from the agent wallet without sending it. Runs the real on-chain checks " +
				"(signature, context rule, spending-limit policy) in simulation and reports whether it would succeed.",
			Schema: map[string]any{"type": "object", "properties": map[string]any{"to": addr, "amount": amount},
				"required": []string{"to", "amount"}, "additionalProperties": false},
		},
		{
			Name: "pay",
			Description: "Send USDC from the agent wallet on Stellar testnet. Enforced on-chain by the wallet's spending-limit " +
				"policy: payments over the remaining daily limit are rejected with error spending_limit_exceeded. Payments " +
				"above the approval threshold wait for the human to approve. Pass an idempotency_key when retrying so a " +
				"payment is never sent twice. Returns the transaction hash and explorer link.",
			Schema: map[string]any{"type": "object", "properties": map[string]any{
				"to": addr, "amount": amount,
				"memo":            map[string]any{"type": "string", "description": "Optional note for the payment log (not stored on-chain)"},
				"idempotency_key": map[string]any{"type": "string", "description": "Optional unique key; repeating it returns the earlier result instead of paying again"},
			}, "required": []string{"to", "amount"}, "additionalProperties": false},
		},
		{
			Name:        "payment_history",
			Description: "List the most recent payments made by the agent through this wallet server, newest first.",
			Schema: map[string]any{"type": "object", "properties": map[string]any{
				"limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 50, "description": "How many payments (default 10)"},
			}, "additionalProperties": false},
		},
	}
}

func str(args map[string]any, k string) string {
	v, _ := args[k].(string)
	return strings.TrimSpace(v)
}

func fail(e *wallet.Error) Result { return Result{OK: false, Error: e} }

func invalid(format string, a ...any) Result {
	return fail(&wallet.Error{Code: "invalid_argument", Message: fmt.Sprintf(format, a...)})
}

// Call runs a tool. source tags log entries ("chat", "mcp").
func (r *Registry) Call(ctx context.Context, name string, args map[string]any, approve Approver, source string) Result {
	if args == nil {
		args = map[string]any{}
	}
	switch name {
	case "wallet_info":
		return r.walletInfo(ctx)
	case "simulate_payment":
		amt, err := sv.ParseAmount(str(args, "amount"))
		if err != nil {
			return invalid("%v", err)
		}
		res, e := r.W.SimulatePayment(ctx, str(args, "to"), amt)
		if e != nil {
			return fail(e)
		}
		return Result{OK: true, Data: res}
	case "pay":
		return r.pay(ctx, args, approve, source)
	case "payment_history":
		n := 10
		if f, ok := args["limit"].(float64); ok && f >= 1 && f <= 50 {
			n = int(f)
		}
		return Result{OK: true, Data: map[string]any{"payments": r.Log.Recent(n)}}
	}
	return invalid("unknown tool %q", name)
}

func (r *Registry) walletInfo(ctx context.Context) Result {
	st, err := r.W.State(ctx)
	if err != nil {
		return fail(wallet.AsError(err))
	}
	info := map[string]any{
		"address":                    st.Address,
		"network":                    "stellar testnet",
		"balance_usdc":               st.Balances[0].Amount,
		"agent_active":               st.Agent.Active,
		"approval_needed_above_usdc": sv.FormatAmount(r.Threshold),
		"latest_ledger":              st.LatestLedger,
	}
	if st.Limit.Installed {
		l := map[string]any{"limit_usdc": *st.Limit.Limit, "spent_usdc": *st.Limit.Spent, "remaining_usdc": *st.Limit.Remaining,
			"window": fmt.Sprintf("%d ledgers (~%s)", *st.Limit.PeriodLedgers, human(int64(*st.Limit.PeriodLedgers)*wallet.LedgerSeconds))}
		if st.Limit.ResetsInSeconds != nil {
			l["next_reset_in"] = human(*st.Limit.ResetsInSeconds)
		}
		info["spending_limit"] = l
	} else {
		info["spending_limit"] = "none installed"
	}
	return Result{OK: true, Data: info}
}

func human(secs int64) string {
	d := time.Duration(secs) * time.Second
	if d >= time.Hour {
		return fmt.Sprintf("%d h %02d min", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("%d min", int(d.Minutes()))
}

func (r *Registry) pay(ctx context.Context, args map[string]any, approve Approver, source string) Result {
	to, memo, key := str(args, "to"), str(args, "memo"), str(args, "idempotency_key")
	amt, err := sv.ParseAmount(str(args, "amount"))
	if err != nil {
		return invalid("%v", err)
	}
	// serialize payments so idempotency checks and limit prechecks don't race
	if r.PayMu != nil {
		r.PayMu.Lock()
		defer r.PayMu.Unlock()
	}

	if prev, ok := r.Log.ByIdempotencyKey(key); ok {
		return Result{OK: prev.Status == "SUCCESS", Data: map[string]any{"duplicate": true, "payment": prev}, Error: prev.Error}
	}
	if r.Threshold != nil && amt.Cmp(r.Threshold) > 0 {
		// don't bother a human for a payment that is going to fail anyway;
		// over-limit payments go straight to the chain, where the policy rejects them
		_, pe := r.W.Precheck(ctx, to, amt)
		if pe != nil && pe.Code != "spending_limit_exceeded" {
			return fail(pe)
		}
		if pe != nil {
			approve = func(context.Context, Approval) (bool, error) { return true, nil }
		}
		a := Approval{To: to, Amount: sv.FormatAmount(amt), Asset: "USDC",
			Summary: fmt.Sprintf("Agent wants to pay %s USDC → %s", sv.FormatAmount(amt), short(to))}
		if approve == nil {
			return fail(&wallet.Error{Code: "approval_required", Message: fmt.Sprintf(
				"payments above %s USDC need human approval, and this client cannot ask for it", sv.FormatAmount(r.Threshold))})
		}
		ok, err := approve(ctx, a)
		if err != nil {
			return fail(&wallet.Error{Code: "approval_required", Message: "could not get human approval: " + err.Error()})
		}
		if !ok {
			return fail(&wallet.Error{Code: "rejected_by_user", Message: "the person declined this payment"})
		}
	}

	tx, e := r.W.Pay(ctx, to, amt)
	res := Result{OK: e == nil}
	if tx != nil {
		res.Txs = []*wallet.Tx{tx}
		p := db.Payment{Hash: tx.Hash, URL: tx.URL, AgentID: r.AgentID, To: to, Amount: sv.FormatAmount(amt), Asset: "USDC", Memo: memo,
			Status: tx.Status, Error: e, Ledger: tx.Ledger, CreatedAt: time.Now().UTC().Format(time.RFC3339), IdempotencyKey: key, Source: source}
		_ = r.Log.Add(p)
	}
	if e != nil {
		if tx != nil {
			e.Details = withTx(e.Details, tx)
		}
		res.Error = e
		return res
	}
	data := map[string]any{"status": "SUCCESS", "hash": tx.Hash, "url": tx.URL, "to": to, "amount": sv.FormatAmount(amt), "asset": "USDC", "ledger": tx.Ledger}
	if st, err := r.W.State(ctx); err == nil {
		data["balance_after_usdc"] = st.Balances[0].Amount
		if st.Limit.Installed {
			data["limit_remaining_usdc"] = *st.Limit.Remaining
		}
	}
	res.Data = data
	return res
}

func withTx(d map[string]any, tx *wallet.Tx) map[string]any {
	out := map[string]any{}
	for k, v := range d {
		out[k] = v
	}
	out["rejected_tx"] = tx.URL
	return out
}

func short(a string) string {
	if len(a) < 12 {
		return a
	}
	return a[:4] + "…" + a[len(a)-4:]
}
