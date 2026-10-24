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
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp" || r.Header.Get("X-Agent-Session-Id") != "actual-session" || r.Header.Get("X-Agent-Bridge-Token") != "private-bridge" || r.Header.Get("X-Engine") != "grok" {
			t.Errorf("wrong broker identity")
		}
		if r.Header.Get("Authorization") != "Bearer host-key" {
			t.Error("host MCP authorization lost")
		}
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{}}`)
	}))
	defer remote.Close()
	b := &Broker{ctx: context.Background(), session: &Session{ID: "actual-session", BridgeToken: "private-bridge", BaseURL: remote.URL, Engine: "grok", http: remote.Client()}}
	req := httptest.NewRequest(http.MethodPost, "http://local/_mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"project_card_claim"}}`))
	req.Header.Set("Authorization", "Bearer host-key")
	req.Header.Set("X-Agent-Session-Id", "spoof")
	req.Header.Set("X-Agent-Bridge-Token", "spoof")
	response := httptest.NewRecorder()
	b.ServeHTTP(response, req)
	if response.Code != 200 || strings.Contains(response.Body.String(), "private-bridge") {
		t.Fatalf("bad response: %d", response.Code)
	}
}
