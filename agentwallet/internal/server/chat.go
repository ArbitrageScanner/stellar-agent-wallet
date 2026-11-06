package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/agent"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/tools"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/wallet"
)

type conversation struct {
	ID       string
	Owner    string
	AgentID  string
	Messages []agent.Message
	busy     sync.Mutex // one turn at a time
	mu       sync.Mutex
	pending  map[string]chan bool
	used     time.Time
}

func (s *Server) systemPrompt(h *agentHandle) string {
	return fmt.Sprintf(`You are %q, a payments agent that controls a USDC budget on Stellar testnet on behalf of the user.
You pay from the user's OpenZeppelin smart account %s. Your key can only call the USDC contract, and an on-chain
spending-limit policy caps how much you can send per ~24h window. The user (the owner) can change the limit or revoke you.

Rules:
- Use the tools for every fact about the wallet; never invent balances, hashes or links.
- To pay, call pay with the payee address and the amount as a decimal string. Payments above %s USDC need the user's approval; the system asks for it automatically, just call pay.
- If a payment fails, explain the real error. For spending_limit_exceeded say the limit, how much is spent and remaining, and when it resets; suggest a smaller amount or asking the owner to raise the limit. Never retry the same failing payment.
- After a successful payment give the amount, the payee and the stellar.expert link.
- Reply in the user's language, briefly. Format links as markdown.
- Demo payee address (has a USDC trustline): %s`, h.agent.Name, h.account, s.cfg.ApprovalThreshold, s.cfg.DemoPayee)
}

func (s *Server) conversation(id, owner string, h *agentHandle) *conversation {
	s.convMu.Lock()
	defer s.convMu.Unlock()
	if c, ok := s.convs[id]; ok && id != "" && c.Owner == owner && c.AgentID == h.agent.ID {
		c.used = time.Now()
		return c
	}
	c := &conversation{ID: newID(), Owner: owner, AgentID: h.agent.ID,
		Messages: []agent.Message{agent.Text("system", s.systemPrompt(h))},
		pending:  map[string]chan bool{}, used: time.Now()}
	s.convs[c.ID] = c
	return c
}

type sse struct {
	mu sync.Mutex
	w  http.ResponseWriter
	f  http.Flusher
}

func (e *sse) send(name string, data any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	b, _ := json.Marshal(data)
	fmt.Fprintf(e.w, "event: %s\ndata: %s\n\n", name, b)
	e.f.Flush()
}

func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AgentID        string `json:"agent_id"`
		ConversationID string `json:"conversation_id"`
		Message        string `json:"message"`
		Model          string `json:"model"`
	}
	if !parseBody(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Message) == "" {
		writeErr(w, http.StatusBadRequest, "invalid_argument", "message is empty")
		return
	}
	lim := s.cfg.Limits
	if lim.ChatMaxChars > 0 && utf8.RuneCountInString(req.Message) > lim.ChatMaxChars {
		writeErr(w, http.StatusBadRequest, "message_too_long", fmt.Sprintf("messages are limited to %d characters", lim.ChatMaxChars))
		return
	}
	owner := user(r)
	a, err := s.db.Agent(req.AgentID)
	if err != nil || a.Owner != owner || a.Status == "pending" {
		writeErr(w, http.StatusNotFound, "not_found", "no such agent")
		return
	}
	h, err := s.handle(a)
	if err != nil {
		e := wallet.AsError(err)
		writeErr(w, http.StatusConflict, e.Code, e.Message)
		return
	}
	if !s.limiter.allow("chat:"+owner, 30, time.Minute) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many messages, slow down")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, 500, "internal", "streaming unsupported")
		return
	}
	model := s.pickModel(r.Context(), req.Model)
	c := s.conversation(req.ConversationID, owner, h)
	if !c.busy.TryLock() {
		writeErr(w, http.StatusConflict, "busy", "this conversation is still answering the previous message")
		return
	}
	defer c.busy.Unlock()
	if !s.chatBegin(owner) {
		writeLimit(w, "rate_limited", fmt.Sprintf("at most %d chats can answer at once; wait for one to finish", lim.ChatConcurrent), lim.ChatConcurrent, nil)
		return
	}
	defer s.chatEnd(owner)
	// daily quotas: the network first, so a blocked IP doesn't use up the wallet's
	if _, ok, err := s.db.Use("chat:ip:"+clientIP(r), lim.ChatDailyIP); err == nil && !ok {
		writeLimit(w, "daily_limit_reached", "the daily chat limit for this network is reached; it resets at midnight UTC", lim.ChatDailyIP, map[string]any{"resets_at": nextUTCDay()})
		return
	}
	used, ok, err := s.db.Use("chat:wallet:"+owner, lim.ChatDailyWallet)
	if err == nil && !ok {
		writeLimit(w, "daily_limit_reached", fmt.Sprintf("you have used all %d chat messages for today; they reset at midnight UTC", lim.ChatDailyWallet), lim.ChatDailyWallet,
			map[string]any{"used": used, "resets_at": nextUTCDay()})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	out := &sse{w: w, f: flusher}
	out.send("conversation", map[string]any{"id": c.ID})

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				out.mu.Lock()
				fmt.Fprint(w, ": ping\n\n")
				flusher.Flush()
				out.mu.Unlock()
			}
		}
	}()

	c.mu.Lock()
	c.Messages = append(c.Messages, agent.Text("user", req.Message))
	history := trimHistory(c.Messages, lim.ChatHistory)
	c.mu.Unlock()

	approve := func(ctx context.Context, ap tools.Approval) (bool, error) {
		id := newID()
		ch := make(chan bool, 1)
		c.mu.Lock()
		c.pending[id] = ch
		c.mu.Unlock()
		defer func() { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() }()
		out.send("approval_required", map[string]any{"approval_id": id, "tool_call_id": agent.CallID(ctx),
			"summary": ap.Summary, "to": ap.To, "amount": ap.Amount, "asset": ap.Asset})
		select {
		case ok := <-ch:
			out.send("approval_resolved", map[string]any{"approval_id": id, "approved": ok})
			return ok, nil
		case <-time.After(5 * time.Minute):
			out.send("approval_resolved", map[string]any{"approval_id": id, "approved": false})
			return false, errors.New("no decision within 5 minutes")
		case <-ctx.Done():
			return false, ctx.Err()
		}
	}

	added, err := s.agent.Run(ctx, s.guard(a.ID, h.reg), model, history, approve, out.send)
	c.mu.Lock()
	c.Messages = append(c.Messages, added...)
	c.mu.Unlock()
	if err != nil {
		log.Printf("chat %s: %v", c.ID, err)
		out.send("error", map[string]any{"message": err.Error()})
	}
	out.send("done", map[string]any{"usage": map[string]any{"used": used, "limit": lim.ChatDailyWallet, "resets_at": nextUTCDay()}})
}

// trimHistory keeps the system prompt and at most max of the latest messages,
// starting at a user message so no tool result loses its call. The full
// conversation stays on the server for the UI; only the model sees less.
func trimHistory(msgs []agent.Message, max int) []agent.Message {
	if max <= 0 || len(msgs) <= max+1 {
		return append([]agent.Message(nil), msgs...)
	}
	tail := msgs[len(msgs)-max:]
	for len(tail) > 1 && tail[0].Role != "user" {
		tail = tail[1:]
	}
	return append([]agent.Message{msgs[0]}, tail...)
}

func (s *Server) chatBegin(owner string) bool {
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	if max := s.cfg.Limits.ChatConcurrent; max > 0 && s.chatActive[owner] >= max {
		return false
	}
	s.chatActive[owner]++
	return true
}

func (s *Server) chatEnd(owner string) {
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	if s.chatActive[owner]--; s.chatActive[owner] <= 0 {
		delete(s.chatActive, owner)
	}
}

func (s *Server) handleApproval(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Approve bool `json:"approve"`
	}
	if !parseBody(w, r, &req) {
		return
	}
	s.convMu.Lock()
	c := s.convs[r.PathValue("conv")]
	s.convMu.Unlock()
	if c == nil || c.Owner != user(r) {
		writeErr(w, http.StatusNotFound, "not_found", "unknown conversation")
		return
	}
	c.mu.Lock()
	ch := c.pending[r.PathValue("id")]
	c.mu.Unlock()
	if ch == nil {
		writeErr(w, http.StatusNotFound, "not_found", "no pending approval with this id")
		return
	}
	select {
	case ch <- req.Approve:
	default:
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleConversation(w http.ResponseWriter, r *http.Request) {
	s.convMu.Lock()
	c := s.convs[r.PathValue("id")]
	s.convMu.Unlock()
	if c == nil || c.Owner != user(r) {
		writeErr(w, http.StatusNotFound, "not_found", "unknown conversation")
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	msgs := make([]map[string]any, 0, len(c.Messages))
	for _, m := range c.Messages[1:] { // skip the system prompt
		out := map[string]any{"role": m.Role, "content": ""}
		if m.Content != nil {
			out["content"] = *m.Content
		}
		if len(m.ToolCalls) > 0 {
			out["tool_calls"] = m.ToolCalls
		}
		if m.ToolCallID != "" {
			out["tool_call_id"], out["name"] = m.ToolCallID, m.Name
		}
		msgs = append(msgs, out)
	}
	writeJSON(w, 200, map[string]any{"id": c.ID, "agent_id": c.AgentID, "messages": msgs})
}

// guard wraps an agent's registry: revoked agents and pay floods are refused
// by the service before anything reaches the chain.
func (s *Server) guard(agentID string, reg *tools.Registry) agent.Runner {
	return guarded{s: s, id: agentID, reg: reg}
}

type guarded struct {
	s   *Server
	id  string
	reg *tools.Registry
}

func (g guarded) Tools() []tools.Tool { return g.reg.Tools() }

func (g guarded) Call(ctx context.Context, name string, args map[string]any, approve tools.Approver, source string) tools.Result {
	if max := g.s.cfg.Limits.MCPCallsPerMinute; max > 0 && !g.s.limiter.allow("tools:"+g.id, max, time.Minute) {
		return tools.Result{Error: walletErr("rate_limited", fmt.Sprintf("at most %d tool calls per minute for this agent", max))}
	}
	if name == "pay" {
		if a, err := g.s.db.Agent(g.id); err != nil || a.Status != "active" {
			return tools.Result{Error: walletErr("agent_inactive", "the owner revoked this agent")}
		}
		if !g.s.limiter.allow("pay:"+g.id, 20, time.Minute) {
			return tools.Result{Error: walletErr("rate_limited", "too many payments per minute for this agent")}
		}
	}
	return g.reg.Call(ctx, name, args, approve, source)
}

// ---------------------------------------------------------------- models

type model struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	ContextLength int    `json:"context_length"`
}

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	items := []model{}
	if s.cfg.LLMKey != "" {
		if m, err := s.fetchModels(r.Context()); err == nil {
			items = m
		} else {
			log.Printf("models: %v", err)
		}
	}
	writeJSON(w, 200, map[string]any{"default": s.cfg.DefaultModel, "items": items})
}

// pickModel returns the requested model when the gateway lists it, else the
// default (never forwards placeholders or unknown ids).
func (s *Server) pickModel(ctx context.Context, requested string) string {
	if requested == "" || requested == s.cfg.DefaultModel {
		return s.cfg.DefaultModel
	}
	models, err := s.fetchModels(ctx)
	if err != nil {
		return s.cfg.DefaultModel
	}
	for _, m := range models {
		if m.ID == requested {
			return requested
		}
	}
	return s.cfg.DefaultModel
}

func (s *Server) fetchModels(ctx context.Context) ([]model, error) {
	s.modelsMu.Lock()
	defer s.modelsMu.Unlock()
	if s.models != nil && time.Since(s.modelsAt) < time.Hour {
		return s.models, nil
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(s.cfg.LLMURL, "/")+"/models?supported_parameters=tools", nil)
	req.Header.Set("Authorization", "Bearer "+s.cfg.LLMKey)
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("openrouter models: HTTP %d", resp.StatusCode)
	}
	var body struct {
		Data []model `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	s.models, s.modelsAt = body.Data, time.Now()
	return s.models, nil
}
