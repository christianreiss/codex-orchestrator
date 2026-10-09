package agentbus

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestMessagingSendRetryAdvice(t *testing.T) {
	for _, tool := range []string{"agent_send", "agent_request", "agent_call_join"} {
		for _, status := range []int{400, 403, 404, 409, 422, 408, 429, 500, 503, 0} {
			t.Run(tool+"/"+http.StatusText(status), func(t *testing.T) {
				client := &sessionClient{id: "private-session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
					if status == 0 {
						return nil, errors.New("network down")
					}
					return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"message":"fixture rejection","code":"fixture_error"}`))}, nil
				})}}
				id := "fa240a0c-6bf4-4b1d-9a81-71746dbbda25"
				_, err := callMCPTool(context.Background(), client, nil, tool, map[string]any{"to": "Rita", "pin": "0123", "content": "fixture", "client_message_id": id})
				if err == nil {
					t.Fatal("expected error")
				}
				retry := status == 0 || status == 408 || status == 429 || status >= 500
				if strings.Contains(err.Error(), "retry the same") != retry {
					t.Fatal(err)
				}
				if retry && !strings.Contains(err.Error(), id) {
					t.Fatal("lost retry UUID", err)
				}
				if strings.Contains(err.Error(), "private-session") || strings.Contains(err.Error(), "/host/agent-sessions/") {
					t.Fatal("exposed internal session path", err)
				}
			})
		}
	}
}

func TestMCPDiscoveryPassesPageAndName(t *testing.T) {
	var body map[string]any
	client := &sessionClient{id: "fixture", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if !strings.HasSuffix(req.URL.Path, "/list") {
			t.Fatal(req.URL.Path)
		}
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"addresses":[],"total":51,"truncated":true,"next_offset":50}`))}, nil
	})}}
	result, err := callMCPTool(context.Background(), client, nil, "agent_list", map[string]any{"online": true, "engine": "grok", "name": "Amelie", "limit": 25, "offset": 25})
	if err != nil {
		t.Fatal(err)
	}
	if body["include_offline"] != false || body["name"] != "Amelie" || body["engine"] != "grok" || body["limit"] != float64(25) || body["offset"] != float64(25) || result["next_offset"] != float64(50) {
		t.Fatal(body, result)
	}
}

func TestMessagingUUIDRequirementVisibleWithoutFormat(t *testing.T) {
	var catalog []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Schema      struct {
			Properties map[string]map[string]any `json:"properties"`
		} `json:"inputSchema"`
	}
	if err := json.Unmarshal(toolCatalogJSON(), &catalog); err != nil {
		t.Fatal(err)
	}
	for _, tool := range catalog {
		if property, ok := tool.Schema.Properties["client_message_id"]; ok {
			description, _ := property["description"].(string)
			if !strings.Contains(description, "UUID") {
				t.Fatal(tool.Name, "UUID requirement lost when format is omitted")
			}
		}
	}
}

func TestManagedGrokLegacyMCPDefinitionUsesAutomaticReceiver(t *testing.T) {
	for _, tc := range []struct {
		engine, socket string
		automatic      bool
	}{
		{"grok", "/private/leader.sock", true},
		{"grok", "", false},
		{"codex", "/private/leader.sock", false},
	} {
		t.Run(tc.engine+"/"+tc.socket, func(t *testing.T) {
			t.Setenv("CXX_AGENT_PORTAL_ENGINE", tc.engine)
			t.Setenv("CXX_GROK_SOCKET", tc.socket)
			t.Setenv(envSocket, "/fixture/broker.sock")
			t.Setenv(envSessionID, "fixture")
			// A legacy project definition invokes `agent mcp` without --auto.
			// No initialize notification means no receiver/network thread is started.
			request := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"agent_receiver_reply","arguments":{"message_id":"fixture","content":"fixture"}}}`
			input, inputWriter := io.Pipe()
			output, outputWriter := io.Pipe()
			defer input.Close()
			defer inputWriter.Close()
			defer output.Close()
			defer outputWriter.Close()
			done := make(chan error, 1)
			go func() { done <- runMCPCommand(nil, input, outputWriter, io.Discard) }()
			response := make(chan string, 1)
			go func() { line, _ := bufio.NewReader(output).ReadString('\n'); response <- line }()
			if _, err := io.WriteString(inputWriter, request+"\n"); err != nil {
				t.Fatal(err)
			}
			var line string
			select {
			case line = <-response:
			case <-time.After(2 * time.Second):
				t.Fatal("MCP response did not arrive")
			}
			inputWriter.Close()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			expected := "automatic receiver unavailable"
			if tc.automatic {
				expected = "portal delivery is not owned by this receiver"
			}
			if !strings.Contains(line, expected) {
				t.Fatal(line)
			}
		})
	}
}

func TestMessagingErrorsKeepOperationWithoutSessionPath(t *testing.T) {
	for _, path := range []string{"/host/agent-sessions/private-session/agent-messaging/send", "/host/agent-sessions/private-session/receiver/status"} {
		err := (&APIError{Status: 404, Path: path, Code: "fixture_not_found", Message: "fixture"}).Error()
		if strings.Contains(err, "private-session") || strings.Contains(err, "/host/") || !strings.Contains(err, "fixture_not_found") {
			t.Fatal(err)
		}
	}
}
