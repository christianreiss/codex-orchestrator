package agentbus

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestTranslateManagedCLIAndMCP(t *testing.T) {
	path := filepath.Join(t.TempDir(), "translate.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/host/agent-sessions/launch/agent-messaging/translate" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		direction := "name_to_uuid"
		if strings.HasPrefix(body["value"], "agent:") {
			direction = "uuid_to_name"
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"name": "Claudia", "uuid": "11111111-1111-4111-8111-111111111111", "direction": direction, "status": "active"})
	})}
	go server.Serve(listener)
	defer server.Close()
	t.Setenv(envSocket, path)
	t.Setenv(envSessionID, "launch")
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"Claudia"}, "11111111-1111-4111-8111-111111111111\n"},
		{[]string{"agent:11111111-1111-4111-8111-111111111111"}, "Claudia\n"},
	} {
		var out, stderr bytes.Buffer
		if code := RunCommand(append([]string{"translate"}, tc.args...), strings.NewReader(""), &out, &stderr, "test"); code != 0 {
			t.Fatalf("%d: %s", code, stderr.String())
		}
		if out.String() != tc.want {
			t.Fatalf("got %q want %q", out.String(), tc.want)
		}
	}
	var out bytes.Buffer
	if err := runTranslate([]string{"Claudia", "--json"}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"status":"active"`) {
		t.Fatalf("%s", out.String())
	}
	client, err := sessionClientFromEnv(0)
	if err != nil {
		t.Fatal(err)
	}
	params, _ := json.Marshal(map[string]any{"name": "agent_translate", "arguments": map[string]string{"value": "Claudia"}})
	response := handleMCPRequest(context.Background(), client, mcpRequest{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "tools/call", Params: params}, false, newChannelTracker(client))
	raw, _ := json.Marshal(response)
	if !strings.Contains(string(raw), "Claudia") {
		t.Fatalf("%s", raw)
	}
}

func TestTranslationErrorsAndEmptyResponse(t *testing.T) {
	if err := writeTranslation(io.Discard, map[string]any{}, false); err == nil {
		t.Fatal("incomplete lookup succeeded")
	}
	for _, args := range [][]string{{}, {"Claudia", "Tanja"}, {"--json"}} {
		if err := runTranslate(args, io.Discard, io.Discard); err == nil {
			t.Fatalf("invalid args accepted: %v", args)
		}
	}
}

func TestHostTranslationUsesHostKeyWithoutRegisteringALaunch(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			count := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				count++
				if r.URL.Path != "/host/agent-messaging/translate" || r.Header.Get("X-API-Key") != "test-host-key" {
					t.Fatalf("unexpected host request: %s", r.URL.Path)
				}
				_ = json.NewEncoder(w).Encode(map[string]string{"name": "Claudia", "uuid": "uuid", "direction": "name_to_uuid"})
			}))
			defer server.Close()
			cfg := &config.Config{Engine: engine, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-host-key"}}
			out, err := translateWithConfig(context.Background(), cfg, "Claudia")
			if err != nil || out["name"] != "Claudia" || count != 1 {
				t.Fatalf("out=%v count=%d err=%v", out, count, err)
			}
		})
	}
}
