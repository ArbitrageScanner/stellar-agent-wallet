package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/agent"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/tools"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/wallet"
)

const instructions = `Wallet of an AI agent on Stellar testnet: a USDC budget inside the user's OpenZeppelin smart account.
This agent's key may only call the USDC contract, and an on-chain spending-limit policy caps how much it can send per ~24h window.
Use wallet_info to check balance and remaining limit, simulate_payment to dry-run, pay to send.
If pay fails with spending_limit_exceeded, tell the user the limit, how much is left and when it resets; do not retry with the same amount.`

func walletErr(code, msg string) *wallet.Error { return &wallet.Error{Code: code, Message: msg} }

func boolPtr(b bool) *bool { return &b }

// newMCPServer exposes one agent's tools over MCP. Payments above the
// approval threshold are confirmed through MCP elicitation when the client
// supports it.
func newMCPServer(runner agent.Runner) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "agentwallet", Title: "Stellar agent wallet", Version: "0.2.0"},
		&mcp.ServerOptions{Instructions: instructions})
	for _, t := range runner.Tools() {
		t := t
		ann := &mcp.ToolAnnotations{Title: t.Name, ReadOnlyHint: t.Name != "pay", OpenWorldHint: boolPtr(true)}
		if t.Name == "pay" {
			ann.DestructiveHint = boolPtr(true)
		}
		s.AddTool(&mcp.Tool{Name: t.Name, Description: t.Description, InputSchema: t.Schema, Annotations: ann},
			func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				var args map[string]any
				if len(req.Params.Arguments) > 0 {
					if err := json.Unmarshal(req.Params.Arguments, &args); err != nil {
						return toolError(fmt.Sprintf(`{"error":{"code":"invalid_argument","message":%q}}`, err.Error())), nil
					}
				}
				res := runner.Call(ctx, t.Name, args, elicitApprover(req.Session), "mcp")
				return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: res.JSON()}}, IsError: !res.OK}, nil
			})
	}
	return s
}

func toolError(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}, IsError: true}
}

func elicitApprover(ss *mcp.ServerSession) tools.Approver {
	if ss == nil {
		return nil
	}
	return func(ctx context.Context, a tools.Approval) (bool, error) {
		res, err := ss.Elicit(ctx, &mcp.ElicitParams{
			Message: a.Summary + ". Approve this payment?",
			RequestedSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"approve": map[string]any{"type": "boolean", "title": "Approve payment of " + a.Amount + " " + a.Asset},
				},
				"required": []string{"approve"},
			},
		})
		if err != nil {
			return false, fmt.Errorf("this MCP client does not support elicitation (%v); lower the amount or raise APPROVAL_THRESHOLD", err)
		}
		approved, _ := res.Content["approve"].(bool)
		return res.Action == "accept" && approved, nil
	}
}

// RunStdioMCP serves one agent's tools over stdio; the agent is picked by
// its API key (AGENTWALLET_API_KEY).
func (s *Server) RunStdioMCP(ctx context.Context, apiKey string) error {
	a, err := s.db.AgentByAPIKey(apiKey)
	if err != nil {
		return fmt.Errorf("unknown or revoked API key")
	}
	h, err := s.handle(a)
	if err != nil {
		return err
	}
	return newMCPServer(s.guard(a.ID, h.reg)).Run(ctx, &mcp.StdioTransport{})
}

// ---------------------------------------------------------------- HTTP

// mcpSessions binds each MCP session to the agent whose API key opened it,
// so a session id can't be reused with another agent's key.
type mcpSessions struct {
	mu       sync.Mutex
	byID     map[string]string      // session id -> agent id
	servers  map[string]*mcp.Server // agent id -> server
	handlers map[string]http.Handler
}

func newMCPSessions() *mcpSessions {
	return &mcpSessions{byID: map[string]string{}, servers: map[string]*mcp.Server{}, handlers: map[string]http.Handler{}}
}

func (m *mcpSessions) dropAgent(agentID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.servers, agentID)
	delete(m.handlers, agentID)
	for sid, aid := range m.byID {
		if aid == agentID {
			delete(m.byID, sid)
		}
	}
}

type sessionCapture struct {
	http.ResponseWriter
	onSession func(string)
	done      bool
}

func (c *sessionCapture) WriteHeader(code int) {
	if !c.done {
		c.done = true
		if sid := c.Header().Get("Mcp-Session-Id"); sid != "" {
			c.onSession(sid)
		}
	}
	c.ResponseWriter.WriteHeader(code)
}

func (c *sessionCapture) Write(b []byte) (int, error) {
	if !c.done {
		c.WriteHeader(http.StatusOK)
	}
	return c.ResponseWriter.Write(b)
}

func (c *sessionCapture) Flush() {
	if f, ok := c.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *Server) mcpHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		a, err := s.db.AgentByAPIKey(token)
		if err != nil {
			w.Header().Set("WWW-Authenticate", `Bearer realm="agentwallet"`)
			writeErr(w, http.StatusUnauthorized, "unauthorized", "send Authorization: Bearer <agent API key>")
			return
		}
		m := s.mcp
		if sid := r.Header.Get("Mcp-Session-Id"); sid != "" {
			m.mu.Lock()
			owner, known := m.byID[sid]
			m.mu.Unlock()
			if known && owner != a.ID {
				writeErr(w, http.StatusForbidden, "forbidden", "this MCP session belongs to another agent")
				return
			}
		}
		m.mu.Lock()
		hh, ok := m.handlers[a.ID]
		if !ok {
			h, err := s.handle(a)
			if err != nil {
				m.mu.Unlock()
				writeErr(w, 500, "internal", err.Error())
				return
			}
			srv := newMCPServer(s.guard(a.ID, h.reg))
			m.servers[a.ID] = srv
			hh = mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv }, nil)
			m.handlers[a.ID] = hh
		}
		m.mu.Unlock()
		hh.ServeHTTP(&sessionCapture{ResponseWriter: w, onSession: func(sid string) {
			m.mu.Lock()
			if _, exists := m.byID[sid]; !exists {
				m.byID[sid] = a.ID
			}
			m.mu.Unlock()
		}}, r)
	})
}
