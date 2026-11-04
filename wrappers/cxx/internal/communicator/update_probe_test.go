package communicator

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

// A refused control channel must not strand a host on its release: POST
// /cron/check reaches the server over direct HTTPS when the owner says the
// channel is unavailable, while a credential verdict and every other managed
// request keep the owner's answer.
func TestUpdateProbeFallsBackToDirectHTTPSWhenChannelUnavailable(t *testing.T) {
	dir, err := os.MkdirTemp("", "cxu")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	verdict := false
	socket := ownerSocket(t, dir, "o.sock", func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		if verdict {
			w.Header().Set("X-Cxx-Communicator-Refusal", "handshake")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"status":"error","code":"ip_mismatch","message":"API key not allowed from this IP"}`))
			return
		}
		writeUnavailableCause(w, false, "communicator handshake rejected")
	})
	base := "https://coco.example/api"
	ep := &endpoint{base: base, socket: socket}
	ep.once.Do(func() {})
	registry.Store(base, ep)
	t.Cleanup(func() { registry.Delete(base) })
	var direct []string
	transport := &Transport{Direct: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(r.Body)
		direct = append(direct, r.Method+" "+r.URL.Path+" "+string(body))
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"action":"no_update"}`))}, nil
	})}
	post := func(path string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest("POST", "https://coco.example"+path, bytes.NewReader([]byte(`{"engine":"codex"}`)))
		res, err := transport.RoundTrip(req)
		if err != nil {
			t.Fatal(path, err)
		}
		return res
	}
	if res := post("/api/cron/check"); res.StatusCode != 200 {
		t.Fatal("update probe not sent over direct HTTPS", res.StatusCode)
	}
	if len(direct) != 1 || direct[0] != `POST /api/cron/check {"engine":"codex"}` {
		t.Fatal("update probe body not replayed", direct)
	}
	res := post("/api/auth")
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != 503 || !strings.Contains(string(raw), "communicator handshake rejected") || len(direct) != 1 {
		t.Fatal("managed request bypassed the communicator", res.StatusCode, string(raw), direct)
	}
	verdict = true
	if res := post("/api/cron/check"); res.StatusCode != 401 || len(direct) != 1 {
		t.Fatal("credential verdict retried over direct HTTPS", res.StatusCode, direct)
	}
}

// When no owner can be started at all, the update probe goes direct too.
func TestUpdateProbeBypassesBrokenOwner(t *testing.T) {
	base := "https://coco.example/api"
	registry.Store(base, &endpoint{base: base, socket: "/nonexistent/control.sock", setupErr: errors.New("unsafe communicator runtime directory")})
	t.Cleanup(func() { registry.Delete(base) })
	called := false
	transport := &Transport{Direct: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		called = true
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})}
	req, _ := http.NewRequest("POST", "https://coco.example/api/cron/check", strings.NewReader("{}"))
	if res, err := transport.RoundTrip(req); err != nil || res.StatusCode != 200 || !called {
		t.Fatal("update probe blocked by a broken owner", err)
	}
}
