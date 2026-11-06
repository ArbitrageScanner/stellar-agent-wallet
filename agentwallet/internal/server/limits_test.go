package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stellar/go-stellar-sdk/keypair"

	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/agent"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/config"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/db"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/vault"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/wallet"
)

// textLLM answers every request with a short text and counts the calls.
func textLLM(calls *int) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls++
		b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": "ok"}}}})
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", b)
	}))
}

func limitsServer(t *testing.T, lim config.Limits, llmURL string) (*httptest.Server, string, string) {
	t.Helper()
	store, err := db.Open(filepath.Join(t.TempDir(), "l.db"))
	if err != nil {
		t.Fatal(err)
	}
	key, _ := base64.StdEncoding.DecodeString(vault.NewKey())
	v, _ := vault.New(key)
	relayer, _ := keypair.Random()
	cfg := &config.App{Vault: v, LLMKey: "k", LLMURL: llmURL, DefaultModel: "m", ApprovalThreshold: "2", Limits: lim,
		Wallet: wallet.Config{Relayer: relayer, Passphrase: "Test SDF Network ; September 2015"}}
	s := New(cfg, wallet.New(cfg.Wallet), store)

	user, _ := keypair.Random()
	agentKP, _ := keypair.Random()
	if err := store.UpsertUser(user.Address(), "CACCOUNT"); err != nil {
		t.Fatal(err)
	}
	rule := uint32(1)
	if err := store.CreateAgent(db.Agent{ID: "ag_1", Owner: user.Address(), Name: "bot", PublicKey: agentKP.Address(),
		SecretEnc: v.Seal([]byte(agentKP.Seed()), "agent:ag_1"), RuleID: &rule, Status: "active"}); err != nil {
		t.Fatal(err)
	}
	sess, _ := store.CreateSession(user.Address(), time.Hour)
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, sess, user.Address()
}

func postChat(t *testing.T, ts *httptest.Server, sess, msg string) (int, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"agent_id": "ag_1", "message": msg})
	req, _ := http.NewRequest("POST", ts.URL+"/api/chat", bytes.NewReader(body))
	req.Header.Set(csrfHeader, "1")
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: sess})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestChatDailyLimitAndMessageSize(t *testing.T) {
	calls := 0
	llm := textLLM(&calls)
	defer llm.Close()
	ts, sess, _ := limitsServer(t, config.Limits{ChatDailyWallet: 2, ChatMaxChars: 10, ChatConcurrent: 3}, llm.URL)

	if code, body := postChat(t, ts, sess, strings.Repeat("x", 11)); code != 400 || !strings.Contains(body, "message_too_long") {
		t.Fatalf("long message: %d %s", code, body)
	}
	for i := 1; i <= 2; i++ {
		code, body := postChat(t, ts, sess, "hi")
		if code != 200 || !strings.Contains(body, fmt.Sprintf(`"used":%d`, i)) {
			t.Fatalf("message %d: %d %s", i, code, body)
		}
	}
	code, body := postChat(t, ts, sess, "hi")
	if code != http.StatusTooManyRequests || !strings.Contains(body, "daily_limit_reached") || !strings.Contains(body, "resets_at") {
		t.Fatalf("3rd message over a limit of 2: %d %s", code, body)
	}
	if calls != 2 {
		t.Fatalf("model called %d times, want 2 (rejected messages must not reach it)", calls)
	}
}

func TestServiceWideModelBudget(t *testing.T) {
	calls := 0
	llm := textLLM(&calls)
	defer llm.Close()
	ts, sess, _ := limitsServer(t, config.Limits{LLMDailyCalls: 1}, llm.URL)
	if code, body := postChat(t, ts, sess, "one"); code != 200 || strings.Contains(body, "event: error") {
		t.Fatalf("first: %d %s", code, body)
	}
	code, body := postChat(t, ts, sess, "two")
	if code != 200 || !strings.Contains(body, "daily model budget") {
		t.Fatalf("second should stop with the budget error: %d %s", code, body)
	}
	if calls != 1 {
		t.Fatalf("model called %d times, want 1", calls)
	}
}

func TestTrimHistory(t *testing.T) {
	msgs := []agent.Message{agent.Text("system", "s")}
	for i := 0; i < 10; i++ {
		msgs = append(msgs, agent.Text("user", fmt.Sprint(i)))
		a := agent.Message{Role: "assistant", ToolCalls: []agent.ToolCall{{ID: fmt.Sprint(i)}}}
		tool := agent.Text("tool", "r")
		tool.ToolCallID = fmt.Sprint(i)
		msgs = append(msgs, a, tool)
	}
	got := trimHistory(msgs, 5)
	if got[0].Role != "system" || got[1].Role != "user" || len(got) > 6 {
		t.Fatalf("trimmed: %d messages, first roles %s %s", len(got), got[0].Role, got[1].Role)
	}
	if len(trimHistory(msgs[:3], 5)) != 3 {
		t.Fatal("short history must stay whole")
	}
}
