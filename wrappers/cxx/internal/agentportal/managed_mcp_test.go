package agentportal

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestManagedMCPBrokerInjectsOnlyItsSessionIdentity(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) { testManagedMCPBrokerIdentity(t, engine) })
	}
}

func testManagedMCPBrokerIdentity(t *testing.T, engine string) {
	t.Helper()
	const requestBody = `{"jsonrpc":"2.0","id":9007199254740993,"method":"tools/call","params":{"name":"project_card_claim"}}`
	const responseBody = `{"jsonrpc":"2.0","id":9007199254740993,"result":{}}`
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp" || r.Header.Get("X-Agent-Session-Id") != "actual-session" || r.Header.Get("X-Agent-Bridge-Token") != "private-bridge" || r.Header.Get("X-Engine") != engine {
			t.Errorf("wrong broker identity")
		}
		if r.Header.Get("Authorization") != "Bearer host-key" {
			t.Error("host MCP authorization lost")
		}
		raw, err := io.ReadAll(r.Body)
		if err != nil || string(raw) != requestBody {
			t.Errorf("MCP payload changed: %s, %v", raw, err)
		}
		_, _ = io.WriteString(w, responseBody)
	}))
	defer remote.Close()
	b := &Broker{ctx: context.Background(), session: &Session{ID: "actual-session", BridgeToken: "private-bridge", BaseURL: remote.URL, Engine: engine, http: remote.Client()}}
	req := httptest.NewRequest(http.MethodPost, "http://local/_mcp", strings.NewReader(requestBody))
	req.Header.Set("Authorization", "Bearer host-key")
	req.Header.Set("X-Agent-Session-Id", "spoof")
	req.Header.Set("X-Agent-Bridge-Token", "spoof")
	req.Header.Set("X-Engine", "spoof")
	response := httptest.NewRecorder()
	b.ServeHTTP(response, req)
	if response.Code != 200 || response.Body.String() != responseBody {
		t.Fatalf("bad response: %d", response.Code)
	}
}
