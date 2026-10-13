package communicator

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func rejectingServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(s.Close)
	return s
}

// "bad status" told the operator nothing: the server states exactly why it refuses
// a host (IP not allowed, key revoked, communicator switched off), and that answer
// is what direct HTTPS would have shown.
func TestHandshakeRejectionNamesTheServersReason(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		body   string
		want   []string
	}{
		"ip binding":   {401, `{"status":"error","message":"API key not allowed from this IP","code":"ip_mismatch"}`, []string{"HTTP 401", "ip_mismatch", "API key not allowed from this IP"}},
		"switched off": {403, `{"status":"error","message":"Communicator is disabled","code":"communicator_disabled"}`, []string{"HTTP 403", "communicator_disabled"}},
		"plain text":   {502, "bad gateway", []string{"HTTP 502", "bad gateway"}},
	} {
		t.Run(name, func(t *testing.T) {
			server := rejectingServer(t, tc.status, tc.body)
			cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "host-key"}}
			transport, err := directTransport(cfg)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, err = dial(ctx, cfg, transport)
			if err == nil {
				t.Fatal("handshake against a refusing server must fail")
			}
			for _, want := range tc.want {
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("error %q lacks %q", err, want)
				}
			}
			if strings.Contains(err.Error(), "host-key") {
				t.Fatal("the host key must never appear in an error")
			}
		})
	}
}

// A local client that gets a 503 must be able to read why, not just a code that
// repeats itself.
func TestUnavailableReplyCarriesTheConnectionError(t *testing.T) {
	s := &server{lastError: "communicator handshake rejected: HTTP 401 ip_mismatch (API key not allowed from this IP)"}
	rec := httptest.NewRecorder()
	s.writeUnavailable(rec, false)
	if rec.Code != 503 {
		t.Fatalf("status %d", rec.Code)
	}
	var out struct {
		Error struct{ Code, Message string }
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Error.Code != "communicator_unavailable" || !strings.Contains(out.Error.Message, "ip_mismatch") {
		t.Fatalf("unexpected body %s", rec.Body.String())
	}
	unknown := httptest.NewRecorder()
	s.writeUnavailable(unknown, true)
	if unknown.Code != 409 || !strings.Contains(unknown.Body.String(), "communicator_outcome_unknown") {
		t.Fatalf("unknown outcome reply %d %s", unknown.Code, unknown.Body.String())
	}
	quiet := httptest.NewRecorder()
	(&server{}).writeUnavailable(quiet, false)
	if strings.Contains(quiet.Body.String(), ": \"") && strings.Contains(quiet.Body.String(), "unavailable: ") {
		t.Fatalf("no cause known, none must be invented: %s", quiet.Body.String())
	}
}
