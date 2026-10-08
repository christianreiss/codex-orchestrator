package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

// Every locally exposed tool is dispatched against a fake broker. No real
// peer, portal, schedule or fleet state is touched by this catalogue sweep.
func TestMCPCatalogCompatibility(t *testing.T) {
	var catalog []struct {
		Name   string `json:"name"`
		Schema struct {
			Properties map[string]map[string]any `json:"properties"`
			Required   []string                  `json:"required"`
		} `json:"inputSchema"`
	}
	if err := json.Unmarshal(toolCatalogJSON(), &catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog) != 27 {
		t.Fatalf("review new tools: got %d", len(catalog))
	}
	// Optional export lets the real Grok MCP doctor load exactly this catalogue
	// from a disposable local server without provider credentials.
	if path := os.Getenv("CXX_MCP_CATALOG_EXPORT"); path != "" {
		if err := os.WriteFile(path, toolCatalogJSON(), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, tool := range catalog {
		t.Run(tool.Name, func(t *testing.T) {
			args := map[string]any{}
			for _, key := range tool.Schema.Required {
				args[key] = "fixture"
			}
			switch tool.Name {
			case "agent_subscribe", "agent_unsubscribe", "agent_publish":
				args["topic"] = "group:fixture"
			case "agent_call_join":
				args["pin"] = "0042"
			case "agent_conf_join":
				args["conference_id"] = "fixture"
			case "agent_conf_invite":
				args["to"] = []any{"agent:fixture"}
			case "agent_task_result":
				args["task_result"] = map[string]any{"status": "succeeded", "summary": "fixture"}
			}
			for _, fail := range []bool{false, true} {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				requests := 0
				client := &sessionClient{id: "fixture", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
					requests++
					code, body := 200, `{}`
					if fail {
						code, body = 400, `{"error":"fixture service failure"}`
					}
					return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
				})}}
				tracker := newChannelTracker(client)
				if tool.Name == "agent_task_result" {
					tracker.track(ctx, "fixture", "fixture-claim")
				}
				if tool.Name == "agent_receiver_reply" {
					tracker.receiver = &autoReceiver{client: client, pendingPortal: map[string]any{"message_id": "fixture"}}
				}
				params, _ := json.Marshal(map[string]any{"name": tool.Name, "arguments": args})
				result := handleMCPRequest(ctx, client, mcpRequest{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "tools/call", Params: params}, false, tracker)
				raw, err := json.Marshal(result)
				if err != nil {
					t.Fatal(err)
				}
				var wire struct {
					Error  any `json:"error"`
					Result struct {
						IsError bool `json:"isError"`
						Content []struct {
							Type string `json:"type"`
							Text string `json:"text"`
						} `json:"content"`
					} `json:"result"`
				}
				if err := json.Unmarshal(raw, &wire); err != nil {
					t.Fatal(err)
				}
				if wire.Error != nil || wire.Result.IsError != fail {
					t.Fatalf("fail=%v response=%s", fail, raw)
				}
				if len(wire.Result.Content) != 1 || wire.Result.Content[0].Type != "text" {
					t.Fatalf("invalid content: %s", raw)
				}
				if requests == 0 {
					t.Fatalf("handler never reached fake broker: %s", raw)
				}
				cancel()
			}
		})
	}
}
