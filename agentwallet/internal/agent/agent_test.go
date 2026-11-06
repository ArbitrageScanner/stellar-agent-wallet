package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/tools"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/wallet"
)

type fakeRunner struct{ approved *bool }

func (fakeRunner) Tools() []tools.Tool {
	return []tools.Tool{{Name: "pay", Description: "pay", Schema: map[string]any{"type": "object"}}}
}

func (f fakeRunner) Call(ctx context.Context, name string, args map[string]any, approve tools.Approver, _ string) tools.Result {
	if args["amount"] == "10" {
		return tools.Result{Error: &wallet.Error{Code: "spending_limit_exceeded", Message: "limit"}}
	}
	ok, _ := approve(ctx, tools.Approval{Amount: fmt.Sprint(args["amount"])})
	*f.approved = ok
	return tools.Result{OK: true, Data: map[string]any{"hash": "abc"}, Txs: []*wallet.Tx{{Hash: "abc", Status: "SUCCESS"}}}
}

// mockOpenRouter streams a tool call (arguments split across chunks, like
// real providers) after a user message, and text after a tool result.
func mockOpenRouter(t *testing.T) *httptest.Server {
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
		fmt.Fprint(w, ": OPENROUTER PROCESSING\n\n")
		if last.Role == "user" {
			amount := "3"
			if strings.Contains(*last.Content, "10") {
				amount = "10"
			}
			args := fmt.Sprintf(`{"to":"GPAYEE","amount":"%s"}`, amount)
			send(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"tool_calls": []any{
				map[string]any{"index": 0, "id": "call_1", "function": map[string]any{"name": "pay", "arguments": args[:9]}}}}}}})
			send(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"tool_calls": []any{
				map[string]any{"index": 0, "function": map[string]any{"arguments": args[9:]}}}}}}})
		} else {
			send(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": "Done: "}}}})
			send(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": "sent."}}}})
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
}

func TestRunWithApprovalAndStructuredError(t *testing.T) {
	llm := mockOpenRouter(t)
	defer llm.Close()
	a := &Agent{BaseURL: llm.URL, APIKey: "k"}
	approved := false
	runner := fakeRunner{approved: &approved}
	var events []string
	emit := func(name string, data any) {
		events = append(events, name)
		if name == "tool_call" {
			args := data.(map[string]any)["arguments"].(map[string]any)
			if args["to"] != "GPAYEE" {
				t.Errorf("arguments reassembled wrong: %v", args)
			}
		}
	}
	added, err := a.Run(context.Background(), runner, "m", []Message{Text("user", "pay 3")},
		func(context.Context, tools.Approval) (bool, error) { return true, nil }, emit)
	if err != nil {
		t.Fatal(err)
	}
	if !approved {
		t.Fatal("approval callback not used")
	}
	if got := strings.Join(events, ","); got != "tool_call,tx,tool_result,text_delta,text_delta" {
		t.Fatalf("events %s", got)
	}
	if len(added) != 3 || added[1].Role != "tool" || *added[2].Content != "Done: sent." {
		t.Fatalf("messages: %+v", added)
	}

	events = nil
	added, _ = a.Run(context.Background(), runner, "m", []Message{Text("user", "pay 10")}, nil, emit)
	if !strings.Contains(*added[1].Content, "spending_limit_exceeded") {
		t.Fatalf("tool message lacks structured error: %s", *added[1].Content)
	}
}

func TestRunWithoutKey(t *testing.T) {
	if _, err := (&Agent{}).Run(context.Background(), fakeRunner{}, "m", nil, nil, func(string, any) {}); err == nil {
		t.Fatal("expected an error without OPENROUTER_API_KEY")
	}
}
