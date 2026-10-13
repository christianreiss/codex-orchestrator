package communicator

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// A wrapper reads 401/403 as "the server judged this host" (terminal, never bridged by
// cached auth) and 503 as "try again". A refused handshake must keep that distinction,
// and only for the answers that are about the host.
func TestHandshakeRefusalSeparatesHostVerdictsFromAnUnavailableChannel(t *testing.T) {
	for name, tc := range map[string]struct {
		status  int
		body    string
		code    string
		verdict bool
	}{
		// missing_api_key cannot occur through the owner (it always sends the host key);
		// it is here because the classification must not depend on that.
		"missing key":          {401, `{"status":"error","message":"API key missing","code":"missing_api_key"}`, "missing_api_key", true},
		"revoked key":          {401, `{"status":"error","message":"Invalid API key","code":"invalid_api_key"}`, "invalid_api_key", true},
		"ip binding":           {401, `{"status":"error","message":"API key not allowed from this IP","code":"ip_mismatch"}`, "ip_mismatch", true},
		"reverse dns":          {401, `{"status":"error","message":"Reverse DNS check failed","code":"reverse_dns_failed"}`, "reverse_dns_failed", true},
		"expired temporary":    {401, `{"status":"error","message":"Temporary host expired","code":"host_expired"}`, "host_expired", true},
		"disabled host":        {403, `{"status":"error","message":"Host disabled","code":"host_disabled"}`, "host_disabled", true},
		"nested openai shape":  {401, `{"error":{"message":"Invalid API key","code":"invalid_api_key"}}`, "invalid_api_key", true},
		"communicator off":     {403, `{"status":"error","message":"Communicator is disabled","code":"communicator_disabled"}`, "communicator_disabled", false},
		"kill switch":          {403, `{"status":"error","message":"API disabled","code":"api_disabled"}`, "api_disabled", false},
		"bad gateway":          {502, "bad gateway", "", false},
		"unrelated forbidden":  {403, `{"status":"error","message":"nope","code":"forbidden"}`, "forbidden", false},
		"upgrade required":     {426, `{"status":"error","message":"upgrade","code":"upgrade_required"}`, "upgrade_required", false},
		"service unavailable":  {503, `{"status":"error","message":"down","code":"unavailable"}`, "unavailable", false},
		"unauthenticated blob": {401, "<html>proxy login</html>", "", true},
	} {
		t.Run(name, func(t *testing.T) {
			upstream := rejectingServer(t, tc.status, tc.body)
			cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: upstream.URL, APIKey: "host-key"}}
			transport, err := directTransport(cfg)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, err = dial(ctx, cfg, transport)
			var refusal *handshakeRefusal
			if !errors.As(err, &refusal) {
				t.Fatalf("a refused upgrade must carry the structured verdict, got %v", err)
			}
			if refusal.Status != tc.status || refusal.Code != tc.code {
				t.Fatalf("verdict %d %q, want %d %q", refusal.Status, refusal.Code, tc.status, tc.code)
			}
			if refusal.hostVerdict() != tc.verdict {
				t.Fatalf("hostVerdict() = %v for %d %q", refusal.hostVerdict(), refusal.Status, refusal.Code)
			}
			if string(refusal.Body) != tc.body {
				t.Fatalf("body %q was not kept verbatim", refusal.Body)
			}
			if !strings.HasPrefix(err.Error(), "communicator handshake rejected: HTTP ") || strings.Contains(err.Error(), "host-key") {
				t.Fatalf("diagnostic text changed or leaked: %q", err)
			}
		})
	}
}

func refusedOwner(t *testing.T, refusal *handshakeRefusal) *server {
	t.Helper()
	// An established outage: the last attempt just failed, so waitConnection reports
	// it at once and the request falls through to the unavailable reply.
	s := newTestServer(3, time.Now())
	s.lastError = "communicator handshake rejected: HTTP 401 invalid_api_key (Invalid API key)"
	s.refusal = refusal
	return s
}

// Direct HTTPS answers every route with the server's verdict. Through the owner a
// request that never left this machine gets the same status and code, not a 503
// that wrappers retry or bridge with cached credentials.
func TestOwnerRepliesWithTheServersHostVerdictWhenNothingWasSent(t *testing.T) {
	verdict := &handshakeRefusal{Status: 401, Code: "invalid_api_key", Body: []byte(`{"status":"error","message":"Invalid API key","code":"invalid_api_key"}`), detail: "invalid_api_key (Invalid API key)"}
	for _, method := range []string{"GET", "POST", "DELETE"} {
		w := httptest.NewRecorder()
		refusedOwner(t, verdict).ServeHTTP(w, httptest.NewRequest(method, "/auth", nil))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status %d, want the server's 401: %s", method, w.Code, w.Body.String())
		}
		var out struct{ Code string }
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || out.Code != "invalid_api_key" {
			t.Fatalf("%s: body %q (%v)", method, w.Body.String(), err)
		}
		if w.Header().Get("Content-Type") != "application/json" {
			t.Fatalf("%s: content type %q", method, w.Header().Get("Content-Type"))
		}
	}
}

func TestOwnerRepliesWithAHostVerdictOnTheDaemonChannelToo(t *testing.T) {
	verdict := &handshakeRefusal{Status: 403, Code: "host_disabled", Body: []byte(`{"status":"error","message":"Host disabled","code":"host_disabled"}`), detail: "host_disabled (Host disabled)"}
	w := httptest.NewRecorder()
	refusedOwner(t, verdict).ServeHTTP(w, httptest.NewRequest("GET", "/_comm/daemon", nil))
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "host_disabled") {
		t.Fatalf("daemon channel: %d %s", w.Code, w.Body.String())
	}
}

// Everything that is not a verdict on the host stays the retryable 503 with the
// reason attached, and an outcome that may already have happened is never turned
// into a credential verdict.
func TestOwnerKeepsAnUnavailableChannelRetryable(t *testing.T) {
	w := httptest.NewRecorder()
	refusedOwner(t, nil).ServeHTTP(w, httptest.NewRequest("GET", "/auth", nil))
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "communicator_unavailable") {
		t.Fatalf("no verdict: %d %s", w.Code, w.Body.String())
	}
	unknown := httptest.NewRecorder()
	refusedOwner(t, &handshakeRefusal{Status: 401, Code: "invalid_api_key", Body: []byte(`{}`)}).writeUnavailable(unknown, true)
	if unknown.Code != http.StatusConflict || !strings.Contains(unknown.Body.String(), "communicator_outcome_unknown") {
		t.Fatalf("an unknown outcome must stay 409: %d %s", unknown.Code, unknown.Body.String())
	}
}

// A refusal describes the last attempt only. A reconnect that fails for another
// reason must not leave a stale verdict behind, and a refusal that is not about the
// host (switched-off communicator, kill switch) is never stored as one.
func TestHostVerdictDoesNotOutliveTheAttemptThatProducedIt(t *testing.T) {
	s := &server{}
	record := func(err error) *handshakeRefusal {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.noteFailureLocked(err)
		return s.refusal
	}
	verdict := &handshakeRefusal{Status: 401, Code: "ip_mismatch", Body: []byte(`{"code":"ip_mismatch"}`), detail: "ip_mismatch"}
	if got := record(errors.Join(errors.New("dial"), verdict)); got != verdict {
		t.Fatalf("a host verdict, even wrapped, must be kept: %v", got)
	}
	if !strings.Contains(s.lastError, "ip_mismatch") {
		t.Fatalf("diagnostic text lost: %q", s.lastError)
	}
	if got := record(errors.New("control connection disconnected")); got != nil {
		t.Fatal("the next failure for another reason replayed a stale verdict")
	}
	record(verdict)
	if got := record(nil); got != nil {
		t.Fatal("an attempt that ends without an error replayed a stale verdict")
	}
	for _, off := range []*handshakeRefusal{
		{Status: 403, Code: "communicator_disabled"},
		{Status: 403, Code: "api_disabled"},
		{Status: 502},
	} {
		if got := record(off); got != nil {
			t.Fatalf("%d %q is the channel being unavailable, not a host verdict", off.Status, off.Code)
		}
	}
}
