// Package agent is a minimal tool-calling agent loop over an OpenAI-compatible
// chat completions API (streaming): OpenRouter, or any compatible gateway.
package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/tools"
)

type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type Message struct {
	Role       string     `json:"role"`
	Content    *string    `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	Name       string     `json:"name,omitempty"`
}

func Text(role, s string) Message { return Message{Role: role, Content: &s} }

// Runner is what the loop needs from the tool registry.
type Runner interface {
	Tools() []tools.Tool
	Call(ctx context.Context, name string, args map[string]any, approve tools.Approver, source string) tools.Result
}

// Emit receives UI events: text_delta, tool_call, tool_result, tx.
type Emit func(name string, data any)

type Agent struct {
	BaseURL  string // https://openrouter.ai/api/v1
	APIKey   string
	MaxSteps int
	HTTP     *http.Client
	Referer  string
}

func toolSpecs(runner Runner) []map[string]any {
	var out []map[string]any
	for _, t := range runner.Tools() {
		out = append(out, map[string]any{"type": "function", "function": map[string]any{
			"name": t.Name, "description": t.Description, "parameters": t.Schema,
		}})
	}
	return out
}

// Run continues the conversation until the model answers without tool calls.
// It returns the messages appended during this turn.
func (a *Agent) Run(ctx context.Context, runner Runner, model string, history []Message, approve tools.Approver, emit Emit) ([]Message, error) {
	if a.APIKey == "" {
		return nil, fmt.Errorf("the chat model is not configured: set LLM_API_KEY (and LLM_BASE_URL, MODEL)")
	}
	steps := a.MaxSteps
	if steps == 0 {
		steps = 8
	}
	var added []Message
	msgs := append([]Message(nil), history...)
	for step := 0; step < steps; step++ {
		msg, err := a.complete(ctx, runner, model, msgs, emit)
		if err != nil {
			return added, err
		}
		msgs = append(msgs, msg)
		added = append(added, msg)
		if len(msg.ToolCalls) == 0 {
			return added, nil
		}
		for _, call := range msg.ToolCalls {
			var args map[string]any
			var res tools.Result
			if err := json.Unmarshal([]byte(orEmpty(call.Function.Arguments)), &args); err != nil {
				res = tools.Result{Error: invalidArgs(err)}
				emit("tool_call", map[string]any{"id": call.ID, "name": call.Function.Name, "arguments": call.Function.Arguments})
			} else {
				emit("tool_call", map[string]any{"id": call.ID, "name": call.Function.Name, "arguments": args})
				res = runner.Call(ctx, call.Function.Name, args, withCall(approve, call.ID), "chat")
			}
			for _, tx := range res.Txs {
				emit("tx", map[string]any{"hash": tx.Hash, "url": tx.URL, "status": tx.Status})
			}
			emit("tool_result", map[string]any{"id": call.ID, "name": call.Function.Name, "ok": res.OK, "result": res.Data, "error": res.Error})
			tm := Text("tool", res.JSON())
			tm.ToolCallID, tm.Name = call.ID, call.Function.Name
			msgs = append(msgs, tm)
			added = append(added, tm)
		}
	}
	note := "Stopped: too many tool calls in a row."
	emit("text_delta", map[string]any{"text": note})
	m := Text("assistant", note)
	return append(added, m), nil
}

type callIDKey struct{}

// CallID returns the tool call id an Approver is invoked for.
func CallID(ctx context.Context) string { s, _ := ctx.Value(callIDKey{}).(string); return s }

func withCall(approve tools.Approver, id string) tools.Approver {
	if approve == nil {
		return nil
	}
	return func(ctx context.Context, a tools.Approval) (bool, error) {
		return approve(context.WithValue(ctx, callIDKey{}, id), a)
	}
}

func orEmpty(s string) string {
	if strings.TrimSpace(s) == "" {
		return "{}"
	}
	return s
}

// complete streams one chat completion and assembles the assistant message.
func (a *Agent) complete(ctx context.Context, runner Runner, model string, msgs []Message, emit Emit) (Message, error) {
	body, _ := json.Marshal(map[string]any{
		"model": model, "messages": msgs, "tools": toolSpecs(runner), "tool_choice": "auto",
		"stream": true, "temperature": 0.2,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(a.BaseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Message{}, err
	}
	req.Header.Set("Authorization", "Bearer "+a.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Title", "agentwallet demo")
	if a.Referer != "" {
		req.Header.Set("HTTP-Referer", a.Referer)
	}
	hc := a.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 180 * time.Second}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return Message{}, fmt.Errorf("openrouter: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return Message{}, fmt.Errorf("openrouter: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	var text strings.Builder
	calls := map[int]*ToolCall{}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue // keep-alive comments like ": OPENROUTER PROCESSING"
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Error   *struct{ Message string } `json:"error"`
			Choices []struct {
				Delta struct {
					Content   string `json:"content"`
					ToolCalls []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if chunk.Error != nil {
			return Message{}, fmt.Errorf("openrouter: %s", chunk.Error.Message)
		}
		for _, ch := range chunk.Choices {
			if ch.Delta.Content != "" {
				text.WriteString(ch.Delta.Content)
				emit("text_delta", map[string]any{"text": ch.Delta.Content})
			}
			for _, tc := range ch.Delta.ToolCalls {
				c := calls[tc.Index]
				if c == nil {
					c = &ToolCall{Type: "function"}
					calls[tc.Index] = c
				}
				if tc.ID != "" {
					c.ID = tc.ID
				}
				c.Function.Name += tc.Function.Name
				c.Function.Arguments += tc.Function.Arguments
			}
		}
	}
	if err := sc.Err(); err != nil {
		return Message{}, fmt.Errorf("openrouter stream: %w", err)
	}

	msg := Message{Role: "assistant"}
	if s := text.String(); s != "" {
		msg.Content = &s
	}
	idx := make([]int, 0, len(calls))
	for i := range calls {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	for n, i := range idx {
		c := *calls[i]
		if c.ID == "" {
			c.ID = fmt.Sprintf("call_%d_%d", time.Now().UnixNano(), n)
		}
		msg.ToolCalls = append(msg.ToolCalls, c)
	}
	if msg.Content == nil && len(msg.ToolCalls) == 0 {
		empty := ""
		msg.Content = &empty
	}
	return msg, nil
}
