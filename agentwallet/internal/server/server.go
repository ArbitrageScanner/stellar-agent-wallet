// Package server is the multi-tenant HTTP side: wallet sign-in (SEP-10),
// per-user smart accounts and agents, signing ops, the chat, the embedded UI
// and MCP for external agents.
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/agent"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/config"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/db"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/wallet"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/web"
)

const (
	sessionCookie = "aw_session"
	sessionTTL    = 12 * time.Hour
	opTTL         = 10 * time.Minute
	csrfHeader    = "X-Agentwallet"
)

type Server struct {
	cfg   *config.App
	base  *wallet.Wallet
	db    *db.DB
	agent *agent.Agent

	opsMu sync.Mutex
	ops   map[string]*op

	convMu sync.Mutex
	convs  map[string]*conversation

	agentsMu sync.Mutex
	agents   map[string]*agentHandle // decrypted agent handles, by agent id

	modelsMu sync.Mutex
	models   []model
	modelsAt time.Time

	limiter *limiter
	mcp     *mcpSessions
}

func New(cfg *config.App, base *wallet.Wallet, store *db.DB) *Server {
	return &Server{
		cfg: cfg, base: base, db: store,
		agent:   &agent.Agent{BaseURL: cfg.LLMURL, APIKey: cfg.LLMKey, MaxSteps: 8, Referer: cfg.PublicURL},
		ops:     map[string]*op{},
		convs:   map[string]*conversation{},
		agents:  map[string]*agentHandle{},
		limiter: newLimiter(),
		mcp:     newMCPSessions(),
	}
}

type userKey struct{}

// user returns the signed-in G address (set by requireUser).
func user(r *http.Request) string { s, _ := r.Context().Value(userKey{}).(string); return s }

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	auth := s.requireUser

	mux.HandleFunc("GET /api/config", s.handleConfig)
	mux.HandleFunc("POST /api/auth/challenge", s.handleChallenge)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("POST /api/dev/fund", s.handleDevFund)
	mux.Handle("GET /api/me", auth(s.handleMe))

	mux.Handle("POST /api/account", auth(s.handleDeploy))
	mux.Handle("GET /api/account", auth(s.handleAccount))
	mux.Handle("POST /api/account/test-usdc/prepare", auth(s.handlePrepareTestUSDC))
	mux.Handle("POST /api/account/fund/prepare", auth(s.handlePrepareFund))
	mux.Handle("POST /api/account/withdraw/prepare", auth(s.handlePrepareWithdraw))
	mux.Handle("POST /api/ops/{id}/submit", auth(s.handleSubmitOp))

	mux.Handle("GET /api/agents", auth(s.handleAgents))
	mux.Handle("POST /api/agents/prepare", auth(s.handlePrepareAgent))
	mux.Handle("POST /api/agents/{id}/limit/prepare", auth(s.handlePrepareLimit))
	mux.Handle("POST /api/agents/{id}/revoke/prepare", auth(s.handlePrepareRevoke))
	mux.Handle("POST /api/agents/{id}/restore/prepare", auth(s.handlePrepareRestore))
	mux.Handle("POST /api/agents/{id}/keys", auth(s.handleCreateKey))
	mux.Handle("DELETE /api/agents/{id}/keys/{prefix}", auth(s.handleRevokeKey))

	mux.Handle("GET /api/payments", auth(s.handlePayments))
	mux.Handle("GET /api/models", auth(s.handleModels))
	mux.Handle("POST /api/chat", auth(s.handleChat))
	mux.Handle("POST /api/chat/{conv}/approvals/{id}", auth(s.handleApproval))
	mux.Handle("GET /api/conversations/{id}", auth(s.handleConversation))

	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeErr(w, http.StatusNotFound, "not_found", "no such endpoint")
	})
	mux.Handle("/mcp", s.mcpHandler())
	static, _ := fs.Sub(web.Static, "static")
	mux.Handle("/", http.FileServerFS(static))
	h := logRequests(securityHeaders(csrf(mux)))
	if s.cfg.TrustProxy {
		h = realIP(h)
	}
	return h
}

func (s *Server) Run(ctx context.Context) error {
	srv := &http.Server{Addr: s.cfg.Listen, Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	go s.gc(ctx)
	log.Printf("listening on %s (%s); relayers: %d; llm configured: %v; dev wallet: %v",
		s.cfg.Listen, s.cfg.PublicURL, len(s.cfg.Wallet.Relayers), s.cfg.LLMKey != "", s.cfg.DevWallet)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// gc drops expired ops, idle conversations and sessions.
func (s *Server) gc(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			now := time.Now()
			s.opsMu.Lock()
			for id, o := range s.ops {
				if now.After(o.expires) {
					delete(s.ops, id)
					if o.onExpire != nil {
						go o.onExpire()
					}
				}
			}
			s.opsMu.Unlock()
			s.convMu.Lock()
			for id, c := range s.convs {
				if now.Sub(c.used) > 24*time.Hour {
					delete(s.convs, id)
				}
			}
			s.convMu.Unlock()
			s.db.PruneSessions()
		}
	}
}

// ---------------------------------------------------------------- middleware

// csrf requires a custom header on state-changing API calls. Browsers can't
// send it cross-site without a CORS preflight, which this server never allows.
func csrf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get(csrfHeader) != "1" {
			writeErr(w, http.StatusForbidden, "csrf", "missing "+csrfHeader+" header")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("X-Frame-Options", "DENY")
		if !strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/mcp" {
			h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireUser(h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized", "sign in with your wallet first")
			return
		}
		addr, err := s.db.SessionAddress(c.Value)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized", "session expired, sign in again")
			return
		}
		h(w, r.WithContext(context.WithValue(r.Context(), userKey{}, addr)))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) { r.status = code; r.ResponseWriter.WriteHeader(code) }
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/mcp" {
			log.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
		}
	})
}

// ---------------------------------------------------------------- rate limits

type limiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func newLimiter() *limiter { return &limiter{hits: map[string][]time.Time{}} }

// allow reports whether key has made fewer than n calls in the last window.
func (l *limiter) allow(key string, n int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	h := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if now.Sub(t) < window {
			h = append(h, t)
		}
	}
	if len(h) >= n {
		l.hits[key] = h
		return false
	}
	l.hits[key] = append(h, now)
	return true
}

func clientIP(r *http.Request) string {
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	return host
}

// ---------------------------------------------------------------- helpers

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func writeWalletErr(w http.ResponseWriter, e *wallet.Error) {
	status := http.StatusBadGateway
	switch e.Code {
	case "invalid_argument", "signature_invalid", "insufficient_balance", "payee_no_trustline":
		status = http.StatusBadRequest
	}
	writeJSON(w, status, map[string]any{"error": e})
}

func parseBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_argument", "invalid JSON body")
		return false
	}
	return true
}

func newID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func txJSON(tx *wallet.Tx) any {
	if tx == nil {
		return nil
	}
	return map[string]any{"hash": tx.Hash, "url": tx.URL, "status": tx.Status}
}

func (s *Server) handleConfig(w http.ResponseWriter, _ *http.Request) {
	c := s.cfg
	writeJSON(w, 200, map[string]any{
		"network": "testnet", "network_passphrase": c.Wallet.Passphrase, "explorer": c.Wallet.Explorer,
		"usdc_contract": c.Wallet.USDC, "default_model": c.DefaultModel, "llm_configured": c.LLMKey != "",
		"approval_threshold": c.ApprovalThreshold, "dev_wallet": c.DevWallet, "demo_payee": c.DemoPayee,
		"period_ledgers": c.PeriodLedgers, "ledger_seconds": wallet.LedgerSeconds, "home_domain": c.HomeDomain,
	})
}

func (s *Server) handleDevFund(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.DevWallet {
		writeErr(w, http.StatusNotFound, "not_found", "dev wallet is disabled")
		return
	}
	var req struct {
		Address string `json:"address"`
	}
	if !parseBody(w, r, &req) {
		return
	}
	if !s.limiter.allow("fund:"+clientIP(r), 10, time.Hour) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many friendbot requests")
		return
	}
	if err := config.Fund(s.cfg.Friendbot, req.Address); err != nil {
		writeErr(w, http.StatusBadGateway, "rpc_error", fmt.Sprintf("friendbot: %v", err))
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// realIP replaces RemoteAddr with the address the nearest reverse proxy put
// last in X-Forwarded-For, so per-IP rate limits see real clients. Enable it
// (TRUST_PROXY=true) only when the listener is reachable solely by that proxy.
func realIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := net.ParseIP(strings.TrimSpace(parts[len(parts)-1])); ip != nil {
				r.RemoteAddr = net.JoinHostPort(ip.String(), "0")
			}
		}
		next.ServeHTTP(w, r)
	})
}
