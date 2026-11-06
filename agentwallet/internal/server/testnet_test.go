//go:build testnet

// End-to-end test of the multi-tenant service against Stellar testnet:
// real accounts, real transactions. Run from agentwallet/ with:
//
//	MASTER_KEY_FILE=... KEYSTORE_FILE=$PWD/data/keystore.enc DEPLOYMENT_FILE=$PWD/../deployments/testnet.json \
//	  go test -tags testnet -run TestTestnet -v -timeout 20m ./internal/server
package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stellar/go-stellar-sdk/keypair"

	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/config"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/db"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/wallet"
)

type client struct {
	t    *testing.T
	base string
	http *http.Client
	kp   *keypair.Full
}

func newClient(t *testing.T, base string) *client {
	jar, _ := cookiejar.New(nil)
	kp, _ := keypair.Random()
	return &client{t: t, base: base, http: &http.Client{Jar: jar, Timeout: 5 * time.Minute}, kp: kp}
}

func (c *client) do(method, path string, body any) (int, map[string]any) {
	c.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.base+path, rd)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(csrfHeader, "1")
	resp, err := c.http.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (c *client) must(method, path string, body any) map[string]any {
	c.t.Helper()
	code, out := c.do(method, path, body)
	if code != 200 {
		c.t.Fatalf("%s %s: HTTP %d %v", method, path, code, out)
	}
	return out
}

func (c *client) sign(op map[string]any) string {
	h, _ := hex.DecodeString(op["hash"].(string))
	sig, _ := c.kp.Sign(h)
	return base64.StdEncoding.EncodeToString(sig)
}

// run prepares an op, signs its hash like the dev wallet does, submits it.
func (c *client) run(step, path string, body any) map[string]any {
	c.t.Helper()
	op := c.must("POST", path, body)
	res := c.must("POST", "/api/ops/"+op["op_id"].(string)+"/submit", map[string]any{"signature": c.sign(op)})
	tx, _ := res["tx"].(map[string]any)
	url := ""
	if tx != nil {
		url = tx["url"].(string)
	}
	if res["ok"] != true {
		c.t.Fatalf("%s failed: %v", step, res["error"])
	}
	c.t.Logf("%-40s %s", step, url)
	return res
}

func (c *client) login() {
	c.t.Helper()
	c.must("POST", "/api/dev/fund", map[string]any{"address": c.kp.Address()})
	op := c.must("POST", "/api/auth/challenge", map[string]any{"address": c.kp.Address()})
	c.must("POST", "/api/auth/login", map[string]any{"op_id": op["op_id"], "signature": c.sign(op)})
}

// scripted OpenRouter: "pay N to G…" -> pay tool call; after a tool -> text.
func scriptedLLM() *httptest.Server {
	re := regexp.MustCompile(`(?i:pay) (\d+(?:\.\d+)?) .*?(G[A-Z2-7]{55})`)
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Messages []struct {
				Role    string  `json:"role"`
				Content *string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		last := req.Messages[len(req.Messages)-1]
		send := func(v any) { b, _ := json.Marshal(v); fmt.Fprintf(w, "data: %s\n\n", b) }
		if m := re.FindStringSubmatch(*last.Content); last.Role == "user" && m != nil {
			args, _ := json.Marshal(map[string]string{"to": m[2], "amount": m[1]})
			send(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"tool_calls": []any{
				map[string]any{"index": 0, "id": "call_1", "function": map[string]any{"name": "pay", "arguments": string(args)}}}}}}})
		} else {
			send(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": "ok"}}}})
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
}

type bearer struct{ token string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

func mcpCall(t *testing.T, base, key, tool string, args map[string]any) (bool, string) {
	t.Helper()
	ctx := context.Background()
	cl := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	sess, err := cl.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: base + "/mcp", HTTPClient: &http.Client{Transport: bearer{key}}}, nil)
	if err != nil {
		return false, "connect: " + err.Error()
	}
	defer sess.Close()
	res, err := sess.CallTool(ctx, &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		return false, err.Error()
	}
	return !res.IsError, res.Content[0].(*mcp.TextContent).Text
}

func TestTestnet(t *testing.T) {
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	llm := scriptedLLM()
	defer llm.Close()
	cfg.DevWallet, cfg.ApprovalThreshold = true, "100"
	// REAL_LLM=1 keeps the configured model (LLM_API_KEY / LLM_BASE_URL / MODEL)
	if os.Getenv("REAL_LLM") == "" || cfg.LLMKey == "" {
		cfg.LLMKey, cfg.LLMURL = "test", llm.URL
	}
	store, err := db.Open(filepath.Join(t.TempDir(), "aw.db"))
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(New(cfg, wallet.New(cfg.Wallet), store).Handler())
	defer ts.Close()
	payee := cfg.DemoPayee

	alice := newClient(t, ts.URL)
	if code, _ := alice.do("GET", "/api/me", nil); code != 401 {
		t.Fatalf("/api/me without session: %d", code)
	}
	req, _ := http.NewRequest("POST", ts.URL+"/api/auth/logout", nil)
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != 403 {
		t.Fatalf("POST without CSRF header: %d", resp.StatusCode)
	}

	alice.login()
	time.Sleep(5 * time.Second) // friendbot funding lands
	me := alice.must("GET", "/api/me", nil)
	t.Logf("alice %s -> account %s", alice.kp.Address(), me["account"])
	dep := alice.must("POST", "/api/account", nil)
	t.Logf("%-40s %v", "deploy account", dep["tx"])

	alice.run("get 10 test USDC", "/api/account/test-usdc/prepare", map[string]any{"amount": "10"})
	alice.run("fund agent wallet 10", "/api/account/fund/prepare", map[string]any{"amount": "10"})
	res := alice.run("add agent (5 USDC/day)", "/api/agents/prepare", map[string]any{"name": "shopper", "daily_limit": "5"})
	result := res["result"].(map[string]any)
	apiKey := result["api_key"].(string)
	agentID := result["agent"].(map[string]any)["id"].(string)
	if !strings.HasPrefix(apiKey, "awk_") {
		t.Fatalf("api key %q", apiKey)
	}

	// chat with the agent: pay 1
	body, _ := json.Marshal(map[string]any{"agent_id": agentID, "message": "pay 1 usdc to " + payee})
	creq, _ := http.NewRequest("POST", ts.URL+"/api/chat", bytes.NewReader(body))
	creq.Header.Set(csrfHeader, "1")
	cresp, err := alice.http.Do(creq)
	if err != nil {
		t.Fatal(err)
	}
	var txEvent string
	sc := bufio.NewScanner(cresp.Body)
	for sc.Scan() {
		if os.Getenv("REAL_LLM") != "" && strings.HasPrefix(sc.Text(), "event: ") {
			t.Logf("  sse %s", sc.Text())
		}
		if os.Getenv("REAL_LLM") != "" && strings.HasPrefix(sc.Text(), "data: ") && !strings.Contains(sc.Text(), "text") {
			t.Logf("      %.300s", sc.Text())
		}
		if strings.HasPrefix(sc.Text(), "data: ") && strings.Contains(sc.Text(), `"status":"SUCCESS"`) {
			txEvent = sc.Text()
		}
	}
	cresp.Body.Close()
	if txEvent == "" {
		t.Fatal("chat pay 1: no successful tx event")
	}
	t.Logf("%-40s %s", "chat: agent pays 1", txEvent[6:])

	// MCP with the agent's API key
	if ok, out := mcpCall(t, ts.URL, apiKey, "pay", map[string]any{"to": payee, "amount": "1"}); !ok {
		t.Fatalf("mcp pay 1: %s", out)
	} else {
		t.Logf("%-40s %s", "mcp: agent pays 1", out)
	}
	if ok, out := mcpCall(t, ts.URL, apiKey, "pay", map[string]any{"to": payee, "amount": "4"}); ok || !strings.Contains(out, "spending_limit_exceeded") {
		t.Fatalf("mcp pay 4 over limit: ok=%v %s", ok, out)
	} else {
		t.Logf("%-40s rejected: spending_limit_exceeded", "mcp: agent pays 4 (2 spent of 5)")
	}
	if ok, out := mcpCall(t, ts.URL, "awk_wrong", "wallet_info", nil); ok {
		t.Fatalf("mcp with a bad key worked: %s", out)
	}

	// isolation: bob can't see or touch alice's agent
	bob := newClient(t, ts.URL)
	bob.login()
	if items := bob.must("GET", "/api/agents", nil)["items"].([]any); len(items) != 0 {
		t.Fatalf("bob sees %d agents", len(items))
	}
	if code, _ := bob.do("POST", "/api/agents/"+agentID+"/keys", nil); code != 404 {
		t.Fatalf("bob created a key on alice's agent: %d", code)
	}
	if code, _ := bob.do("POST", "/api/agents/"+agentID+"/revoke/prepare", nil); code != 404 {
		t.Fatalf("bob prepared a revoke on alice's agent: %d", code)
	}

	alice.run("revoke agent", "/api/agents/"+agentID+"/revoke/prepare", nil)
	if ok, out := mcpCall(t, ts.URL, apiKey, "wallet_info", nil); ok {
		t.Fatalf("revoked agent still served over MCP: %s", out)
	}
	alice.run("restore agent", "/api/agents/"+agentID+"/restore/prepare", nil)
	if ok, out := mcpCall(t, ts.URL, apiKey, "wallet_info", nil); !ok {
		t.Fatalf("restored agent: %s", out)
	}
	alice.run("raise limit to 10", "/api/agents/"+agentID+"/limit/prepare", map[string]any{"daily_limit": "10"})
	alice.run("withdraw 2", "/api/account/withdraw/prepare", map[string]any{"amount": "2"})

	acct := alice.must("GET", "/api/account", nil)
	ag := acct["agents"].([]any)[0].(map[string]any)
	lim := ag["limit"].(map[string]any)
	bal := acct["balances"].([]any)[0].(map[string]any)["amount"]
	t.Logf("final: balance %v, agent %v limit %v spent %v, payments %v", bal, ag["status"], lim["limit"], lim["spent"], ag["payments_count"])
	if bal != "6" || lim["limit"] != "10" || lim["spent"] != "2" || ag["status"] != "active" {
		t.Fatalf("unexpected final state: %v", acct)
	}
	pays := alice.must("GET", "/api/payments", nil)["items"].([]any)
	if len(pays) != 3 {
		t.Fatalf("payments: %d %v", len(pays), pays)
	}
	alice.must("POST", "/api/auth/logout", nil)
	if code, _ := alice.do("GET", "/api/me", nil); code != 401 {
		t.Fatalf("after logout: %d", code)
	}
}
