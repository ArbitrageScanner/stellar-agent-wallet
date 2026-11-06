package server

import (
	"context"
	"fmt"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stellar/go-stellar-sdk/keypair"

	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/db"
	sv "github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/stellar"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/tools"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/wallet"
)

// agentHandle is an agent's decrypted key wired to its owner's account.
type agentHandle struct {
	agent   db.Agent
	account string
	reg     *tools.Registry
	mcp     *mcp.Server
}

// accountOf is the user's smart account. It is recorded at first sign-in and
// read from the db afterwards: the derived address depends on the deployer
// (the primary relayer), so after a keystore rotation re-deriving it would
// point existing users at a new, empty account.
func (s *Server) accountOf(owner string) string {
	if a, err := s.db.UserAccount(owner); err == nil && a != "" {
		return a
	}
	a, _ := s.base.AccountAddress(owner)
	return a
}

// handle loads (and caches) an active agent's tool registry. The agent's
// secret is decrypted only here, into memory.
func (s *Server) handle(a db.Agent) (*agentHandle, error) {
	s.agentsMu.Lock()
	defer s.agentsMu.Unlock()
	if h, ok := s.agents[a.ID]; ok {
		return h, nil
	}
	if a.RuleID == nil {
		return nil, fmt.Errorf("agent %s is not active yet", a.ID)
	}
	secret, err := s.cfg.Vault.Open(a.SecretEnc, "agent:"+a.ID)
	if err != nil {
		return nil, walletErr("agent_key_unavailable", "this agent's key cannot be decrypted with the current master key; revoke it and add a new agent")
	}
	kp, err := keypair.ParseFull(string(secret))
	if err != nil {
		return nil, err
	}
	threshold, _ := sv.ParseAmount(s.cfg.ApprovalThreshold)
	account := s.accountOf(a.Owner)
	h := &agentHandle{agent: a, account: account, reg: &tools.Registry{
		W:         s.base.ForAccount(account, *a.RuleID, kp),
		Log:       db.AgentLog{DB: s.db, Owner: a.Owner, AgentID: a.ID},
		AgentID:   a.ID,
		Threshold: threshold,
		PayMu:     &sync.Mutex{},
	}}
	s.agents[a.ID] = h
	return h, nil
}

func (s *Server) dropHandle(id string) {
	s.agentsMu.Lock()
	delete(s.agents, id)
	s.agentsMu.Unlock()
}

// ownedAgent loads an agent of the signed-in user, or writes a 404.
func (s *Server) ownedAgent(w http.ResponseWriter, r *http.Request) (db.Agent, bool) {
	a, err := s.db.Agent(r.PathValue("id"))
	if err != nil || a.Owner != user(r) || a.Status == "pending" {
		writeErr(w, http.StatusNotFound, "not_found", "no such agent")
		return a, false
	}
	return a, true
}

func amountField(w http.ResponseWriter, s string, max string) (*big.Int, bool) {
	n, err := sv.ParseAmount(s)
	if err != nil || n.Sign() <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid_argument", "amount must be a positive decimal like \"5\"")
		return nil, false
	}
	if m, _ := sv.ParseAmount(max); n.Cmp(m) > 0 {
		writeErr(w, http.StatusBadRequest, "invalid_argument", "amount is capped at "+max+" USDC on this demo")
		return nil, false
	}
	return n, true
}

// ---------------------------------------------------------------- account

func (s *Server) handleDeploy(w http.ResponseWriter, r *http.Request) {
	owner := user(r)
	if !s.limiter.allow("deploy:"+owner, 5, 60*60e9) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many deploy attempts")
		return
	}
	if ok, err := s.base.AccountExists(r.Context(), s.accountOf(owner)); err == nil && ok {
		writeJSON(w, 200, map[string]any{"account": s.accountOf(owner), "tx": nil})
		return
	}
	addr, tx, e := s.base.DeployAccount(r.Context(), owner, s.cfg.AccountWasm)
	if e != nil {
		writeWalletErr(w, e)
		return
	}
	if err := s.db.UpsertUser(owner, addr); err != nil {
		writeErr(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"account": addr, "tx": txJSON(tx)})
}

// requireAccount writes an error unless the user's account is deployed.
func (s *Server) requireAccount(w http.ResponseWriter, r *http.Request) (string, bool) {
	account := s.accountOf(user(r))
	ok, err := s.base.AccountExists(r.Context(), account)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "rpc_error", err.Error())
		return "", false
	}
	if !ok {
		writeErr(w, http.StatusConflict, "account_missing", "create your agent wallet first (POST /api/account)")
		return "", false
	}
	return account, true
}

func (s *Server) handleAccount(w http.ResponseWriter, r *http.Request) {
	account, ok := s.requireAccount(w, r)
	if !ok {
		return
	}
	ov, err := s.base.ForAccount(account, 0, nil).Overview(r.Context())
	if err != nil {
		writeErr(w, http.StatusBadGateway, "rpc_error", err.Error())
		return
	}
	agents, err := s.agentsJSON(user(r), ov)
	if err != nil {
		writeErr(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"address": ov.Address, "url": ov.URL, "balances": ov.Balances,
		"latest_ledger": ov.LatestLedger, "rules": ov.Rules, "agents": agents})
}

func (s *Server) handlePrepareTestUSDC(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Amount string `json:"amount"`
	}
	if !parseBody(w, r, &req) {
		return
	}
	n, ok := amountField(w, req.Amount, "50")
	if !ok {
		return
	}
	owner := user(r)
	bal, err := s.base.GBalances(r.Context(), owner)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "rpc_error", err.Error())
		return
	}
	if !bal.Funded {
		writeErr(w, http.StatusBadRequest, "account_unfunded", "your wallet has no XLM on testnet yet; fund it with friendbot first")
		return
	}
	ut, e := s.base.PrepareGetTestUSDC(r.Context(), owner, n, !bal.USDCTrustline)
	if e != nil {
		writeWalletErr(w, e)
		return
	}
	summary := fmt.Sprintf("Buy %s test USDC for XLM on the testnet DEX", sv.FormatAmount(n))
	if !bal.USDCTrustline {
		summary = "Add a USDC trustline and buy " + sv.FormatAmount(n) + " test USDC for XLM on the testnet DEX"
	}
	writeJSON(w, 200, s.txOp(owner, summary, ut, nil))
}

func (s *Server) handlePrepareFund(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Amount string `json:"amount"`
	}
	if !parseBody(w, r, &req) {
		return
	}
	n, ok := amountField(w, req.Amount, "1000")
	if !ok {
		return
	}
	account, ok := s.requireAccount(w, r)
	if !ok {
		return
	}
	ut, e := s.base.PrepareFund(r.Context(), user(r), account, n)
	if e != nil {
		writeWalletErr(w, e)
		return
	}
	writeJSON(w, 200, s.txOp(user(r), fmt.Sprintf("Send %s USDC from your wallet to your agent wallet", sv.FormatAmount(n)), ut, nil))
}

func (s *Server) handlePrepareWithdraw(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Amount string `json:"amount"`
	}
	if !parseBody(w, r, &req) {
		return
	}
	n, ok := amountField(w, req.Amount, "1000000")
	if !ok {
		return
	}
	account, ok := s.requireAccount(w, r)
	if !ok {
		return
	}
	oc, e := s.base.PrepareWithdraw(r.Context(), account, user(r), n)
	if e != nil {
		writeWalletErr(w, e)
		return
	}
	writeJSON(w, 200, s.authOp(user(r), fmt.Sprintf("Withdraw %s USDC from your agent wallet to your wallet", sv.FormatAmount(n)), oc, nil, nil))
}

// ---------------------------------------------------------------- agents

func (s *Server) agentsJSON(owner string, ov wallet.Overview) ([]map[string]any, error) {
	list, err := s.db.Agents(owner)
	if err != nil {
		return nil, err
	}
	rules := map[uint32]wallet.Rule{}
	for _, r := range ov.Rules {
		rules[r.ID] = r
	}
	out := []map[string]any{}
	for _, a := range list {
		rule, onChain := rules[*a.RuleID]
		status := a.Status
		var validUntil *uint32
		if !onChain {
			// RPC can lag a ledger or two behind the tx that added the rule
			if t, err := time.Parse(time.RFC3339, a.CreatedAt); err != nil || time.Since(t) > 2*time.Minute {
				status = "removed"
			}
		} else {
			validUntil = rule.ValidUntil
			if validUntil != nil && *validUntil < ov.LatestLedger && status == "active" {
				status = "expired"
			}
		}
		lim, ok := ov.Limits[*a.RuleID]
		if !ok {
			lim = wallet.Limit{History: []wallet.SpendEntry{}}
		}
		keys, _ := s.db.APIKeys(a.ID)
		out = append(out, map[string]any{
			"id": a.ID, "name": a.Name, "public_key": a.PublicKey, "rule_id": *a.RuleID, "status": status,
			"valid_until": validUntil, "created_at": a.CreatedAt, "limit": lim, "api_keys": keys,
			"payments_count": s.db.PaymentCount(a.ID),
		})
	}
	return out, nil
}

func (s *Server) handleAgents(w http.ResponseWriter, r *http.Request) {
	account := s.accountOf(user(r))
	ov, err := s.base.ForAccount(account, 0, nil).Overview(r.Context())
	if err != nil {
		if ok, _ := s.base.AccountExists(r.Context(), account); !ok {
			writeJSON(w, 200, map[string]any{"items": []any{}})
			return
		}
		writeErr(w, http.StatusBadGateway, "rpc_error", err.Error())
		return
	}
	items, err := s.agentsJSON(user(r), ov)
	if err != nil {
		writeErr(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *Server) agentJSON(ctx context.Context, owner, id string) map[string]any {
	ov, err := s.base.ForAccount(s.accountOf(owner), 0, nil).Overview(ctx)
	if err != nil {
		return map[string]any{"id": id}
	}
	items, _ := s.agentsJSON(owner, ov)
	for _, a := range items {
		if a["id"] == id {
			return a
		}
	}
	return map[string]any{"id": id}
}

func (s *Server) handlePrepareAgent(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name       string `json:"name"`
		DailyLimit string `json:"daily_limit"`
		ValidDays  *int   `json:"valid_days"`
	}
	if !parseBody(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || utf8.RuneCountInString(req.Name) > 40 {
		writeErr(w, http.StatusBadRequest, "invalid_argument", "name must be 1-40 characters")
		return
	}
	limit, ok := amountField(w, req.DailyLimit, "1000")
	if !ok {
		return
	}
	account, ok := s.requireAccount(w, r)
	if !ok {
		return
	}
	owner := user(r)
	var validUntil *uint32
	if req.ValidDays != nil {
		if *req.ValidDays < 1 || *req.ValidDays > 365 {
			writeErr(w, http.StatusBadRequest, "invalid_argument", "valid_days must be 1-365")
			return
		}
		latest, err := s.base.LatestLedger(r.Context())
		if err != nil {
			writeErr(w, http.StatusBadGateway, "rpc_error", err.Error())
			return
		}
		v := latest + uint32(*req.ValidDays)*17280
		validUntil = &v
	}

	kp, _ := keypair.Random()
	id := db.NewID("ag_")
	a := db.Agent{ID: id, Owner: owner, Name: req.Name, PublicKey: kp.Address(),
		SecretEnc: s.cfg.Vault.Seal([]byte(kp.Seed()), "agent:"+id), Status: "pending"}
	if err := s.db.CreateAgent(a); err != nil {
		writeErr(w, 500, "internal", err.Error())
		return
	}
	oc, e := s.base.PrepareAddAgent(r.Context(), account, owner, req.Name, kp, limit, s.cfg.PeriodLedgers, validUntil)
	if e != nil {
		_ = s.db.DeleteAgent(id)
		writeWalletErr(w, e)
		return
	}
	summary := fmt.Sprintf("Add agent %q with a %s USDC/day limit", req.Name, sv.FormatAmount(limit))
	if req.ValidDays != nil {
		summary += fmt.Sprintf(", valid %d days", *req.ValidDays)
	}
	onSuccess := func(ctx context.Context, tx *wallet.Tx) (any, error) {
		rv := tx.ReturnValue()
		if rv == nil {
			return nil, fmt.Errorf("add_context_rule returned no rule")
		}
		idv, ok := sv.Field(*rv, "id")
		if !ok {
			return nil, fmt.Errorf("add_context_rule result has no id")
		}
		ruleID, _ := sv.Native(idv).(uint32)
		if err := s.db.ActivateAgent(id, ruleID); err != nil {
			return nil, err
		}
		key, _, err := s.db.CreateAPIKey(id)
		if err != nil {
			return nil, err
		}
		return map[string]any{"agent": s.agentJSON(ctx, owner, id), "api_key": key}, nil
	}
	writeJSON(w, 200, s.authOp(owner, summary, oc, onSuccess, func() { _ = s.db.DeleteAgent(id) }))
}

func (s *Server) handlePrepareLimit(w http.ResponseWriter, r *http.Request) {
	a, ok := s.ownedAgent(w, r)
	if !ok {
		return
	}
	var req struct {
		DailyLimit string `json:"daily_limit"`
	}
	if !parseBody(w, r, &req) {
		return
	}
	limit, ok := amountField(w, req.DailyLimit, "1000")
	if !ok {
		return
	}
	account := s.accountOf(a.Owner)
	oc, e := s.base.ForAccount(account, *a.RuleID, nil).PrepareSetLimit(r.Context(), account, a.Owner, *a.RuleID, limit, s.cfg.PeriodLedgers)
	if e != nil {
		writeWalletErr(w, e)
		return
	}
	onSuccess := func(ctx context.Context, _ *wallet.Tx) (any, error) {
		s.dropHandle(a.ID)
		return map[string]any{"agent": s.agentJSON(ctx, a.Owner, a.ID)}, nil
	}
	writeJSON(w, 200, s.authOp(a.Owner, fmt.Sprintf("Set %q limit to %s USDC/day", a.Name, sv.FormatAmount(limit)), oc, onSuccess, nil))
}

func (s *Server) prepareValidity(w http.ResponseWriter, r *http.Request, revoke bool) {
	a, ok := s.ownedAgent(w, r)
	if !ok {
		return
	}
	account := s.accountOf(a.Owner)
	var until *uint32
	if revoke {
		latest, err := s.base.LatestLedger(r.Context())
		if err != nil {
			writeErr(w, http.StatusBadGateway, "rpc_error", err.Error())
			return
		}
		// valid_until is part of what the wallet signs and must not be in the
		// past when the tx applies, so leave ~2 minutes for signing. The
		// service stops the agent as soon as the revoke is confirmed (status
		// in the db); the on-chain expiry is the hard stop on top of that.
		v := latest + 24
		until = &v
	}
	oc, e := s.base.PrepareSetValidUntil(r.Context(), account, a.Owner, *a.RuleID, until)
	if e != nil {
		writeWalletErr(w, e)
		return
	}
	status, verb := "active", "Restore"
	if revoke {
		status, verb = "revoked", "Revoke"
	}
	onSuccess := func(ctx context.Context, _ *wallet.Tx) (any, error) {
		_ = s.db.SetAgentStatus(a.ID, status)
		s.dropHandle(a.ID)
		s.mcp.dropAgent(a.ID)
		return map[string]any{"agent": s.agentJSON(ctx, a.Owner, a.ID)}, nil
	}
	writeJSON(w, 200, s.authOp(a.Owner, fmt.Sprintf("%s agent %q", verb, a.Name), oc, onSuccess, nil))
}

func (s *Server) handlePrepareRevoke(w http.ResponseWriter, r *http.Request) {
	s.prepareValidity(w, r, true)
}
func (s *Server) handlePrepareRestore(w http.ResponseWriter, r *http.Request) {
	s.prepareValidity(w, r, false)
}

func (s *Server) handleCreateKey(w http.ResponseWriter, r *http.Request) {
	a, ok := s.ownedAgent(w, r)
	if !ok {
		return
	}
	key, prefix, err := s.db.CreateAPIKey(a.ID)
	if err != nil {
		writeErr(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"api_key": key, "prefix": prefix})
}

func (s *Server) handleRevokeKey(w http.ResponseWriter, r *http.Request) {
	a, ok := s.ownedAgent(w, r)
	if !ok {
		return
	}
	done, err := s.db.RevokeAPIKey(a.ID, r.PathValue("prefix"))
	if err != nil {
		writeErr(w, 500, "internal", err.Error())
		return
	}
	if !done {
		writeErr(w, http.StatusNotFound, "not_found", "no such API key")
		return
	}
	s.mcp.dropAgent(a.ID)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handlePayments(w http.ResponseWriter, r *http.Request) {
	n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if n <= 0 || n > 200 {
		n = 20
	}
	items, err := s.db.Payments(user(r), r.URL.Query().Get("agent"), "", n)
	if err != nil {
		writeErr(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}
