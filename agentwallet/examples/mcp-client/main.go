// mcp-client connects to agentwallet's MCP endpoint, lists the tools and
// calls one of them. It is what any MCP-capable agent does under the hood.
//
//	go run ./examples/mcp-client                                    # wallet_info
//	go run ./examples/mcp-client simulate_payment '{"to":"G…","amount":"1"}'
//	AGENTWALLET_API_KEY=awk_… MCP_URL=http://host:8090/mcp go run ./examples/mcp-client
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type bearerRT struct{ token string }

func (b bearerRT) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

func main() {
	url := os.Getenv("MCP_URL")
	if url == "" {
		url = "http://localhost:8090/mcp"
	}
	tool, args := "wallet_info", "{}"
	if len(os.Args) > 1 {
		tool = os.Args[1]
	}
	if len(os.Args) > 2 {
		args = os.Args[2]
	}

	transport := &mcp.StreamableClientTransport{Endpoint: url}
	if tok := os.Getenv("AGENTWALLET_API_KEY"); tok != "" {
		transport.HTTPClient = &http.Client{Transport: bearerRT{tok}}
	}
	ctx := context.Background()
	client := mcp.NewClient(&mcp.Implementation{Name: "mcp-client-example", Version: "0.1.0"}, nil)
	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		log.Fatalf("connect %s: %v", url, err)
	}
	defer session.Close()

	list, err := session.ListTools(ctx, nil)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("tools:")
	for _, t := range list.Tools {
		fmt.Printf("  %-17s %s\n", t.Name, firstSentence(t.Description))
	}

	var in map[string]any
	if err := json.Unmarshal([]byte(args), &in); err != nil {
		log.Fatalf("args must be JSON: %v", err)
	}
	res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: tool, Arguments: in})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("\n%s(%s) isError=%v\n", tool, args, res.IsError)
	for _, c := range res.Content {
		if t, ok := c.(*mcp.TextContent); ok {
			var pretty any
			if json.Unmarshal([]byte(t.Text), &pretty) == nil {
				b, _ := json.MarshalIndent(pretty, "", "  ")
				fmt.Println(string(b))
			} else {
				fmt.Println(t.Text)
			}
		}
	}
}

func firstSentence(s string) string {
	for i, r := range s {
		if r == '.' {
			return s[:i+1]
		}
	}
	return s
}
