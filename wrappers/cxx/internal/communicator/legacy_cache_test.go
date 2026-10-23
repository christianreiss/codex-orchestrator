package communicator

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func legacyCacheEndpoint(t *testing.T, remote string, protocol int, requests *atomic.Int32) *endpoint {
	t.Helper()
	dir, err := os.MkdirTemp("", "cxx-old-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := ownerSocket(t, dir, "owner.sock", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/_comm/status" {
			status := map[string]any{"version": "0.9.111", "pid": 123, "sessions": 44}
			if protocol != 0 {
				status["cache"] = map[string]int{"protocol": protocol}
			}
			json.NewEncoder(w).Encode(status)
			return
		}
		requests.Add(1)
		io.WriteString(w, `{"stale":true}`)
	})
	ep := &endpoint{base: remote, socket: socket, anchor: &config.Config{
		Engine:       config.EngineCodex,
		Orchestrator: config.Orchestrator{BaseURL: remote, APIKey: "host-key", CommunicatorProtocol: 1, CommunicatorCacheProtocol: 2},
	}}
	// A test request does not start the process-wide lease loop.
	ep.once.Do(func() {})
	registry.Store(remote, ep)
	t.Cleanup(func() { registry.Delete(remote) })
	return ep
}

func TestLegacyOwnerLostAdmissionProofIsNotReplayed(t *testing.T) {
	var oldRequests, admissions atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		admissions.Add(1)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		conn.Close()
	}))
	defer remote.Close()
	legacyCacheEndpoint(t, remote.URL, 0, &oldRequests)
	req, _ := http.NewRequest("POST", remote.URL+"/auth/sessions", strings.NewReader(`{"engine":"codex"}`))
	res, err := (&Transport{Direct: http.DefaultTransport}).RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 409 || admissions.Load() != 1 || oldRequests.Load() != 0 {
		t.Fatalf("status=%d admissions=%d legacy=%d", res.StatusCode, admissions.Load(), oldRequests.Load())
	}
}

func TestLegacyOwnerBridgeDoesNotRedirectCredentials(t *testing.T) {
	var oldRequests, redirected atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
	defer other.Close()
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", other.URL+"/capture")
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer remote.Close()
	legacyCacheEndpoint(t, remote.URL, 0, &oldRequests)
	req, _ := http.NewRequest("POST", remote.URL+"/auth/sessions", strings.NewReader(`{"engine":"codex"}`))
	res, err := (&Transport{Direct: http.DefaultTransport}).RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode < 400 || redirected.Load() != 0 || oldRequests.Load() != 0 {
		t.Fatalf("status=%d redirects=%d legacy=%d", res.StatusCode, redirected.Load(), oldRequests.Load())
	}
}

func TestLegacyOwnerWritesKeepTheirOriginalBodyAndRoute(t *testing.T) {
	var oldRequests, directRequests atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { directRequests.Add(1) }))
	defer remote.Close()
	dir, err := os.MkdirTemp("", "cxx-old-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	want := `{"command":"store","auth":{"fixture":true}}`
	socket := ownerSocket(t, dir, "owner.sock", func(w http.ResponseWriter, r *http.Request) {
		oldRequests.Add(1)
		raw, _ := io.ReadAll(r.Body)
		if r.URL.Path != "/auth" || string(raw) != want {
			t.Errorf("write changed: path=%s body=%s", r.URL.Path, raw)
		}
		w.WriteHeader(http.StatusAccepted)
	})
	ep := &endpoint{base: remote.URL, socket: socket, anchor: &config.Config{Orchestrator: config.Orchestrator{BaseURL: remote.URL, CommunicatorCacheProtocol: 2}}}
	ep.once.Do(func() {})
	registry.Store(remote.URL, ep)
	t.Cleanup(func() { registry.Delete(remote.URL) })
	req, _ := http.NewRequest("POST", remote.URL+"/auth", io.NopCloser(strings.NewReader(want)))
	res, err := (&Transport{Direct: http.DefaultTransport}).RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 202 || oldRequests.Load() != 1 || directRequests.Load() != 0 {
		t.Fatalf("status=%d legacy=%d direct=%d", res.StatusCode, oldRequests.Load(), directRequests.Load())
	}
}

func TestLegacyOwnerLaunchReadsUseFreshProofBeforeDispatch(t *testing.T) {
	for _, engine := range []string{config.EngineCodex, config.EngineClaude, config.EngineGrok} {
		t.Run(engine, func(t *testing.T) {
			var oldRequests, confirmations, knownRequests atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/sync/cache" || r.Header.Get("X-API-Key") != "host-key" {
					t.Errorf("unexpected direct request: %s", r.URL.Path)
					w.WriteHeader(400)
					return
				}
				confirmations.Add(1)
				raw, _ := io.ReadAll(r.Body)
				var read cacheRead
				json.Unmarshal(raw, &read)
				if len(read.Known) != 0 {
					knownRequests.Add(1)
				}
				if read.Path != "/auth" || read.Headers["x-engine"] != engine || string(read.Body["command"]) != `"retrieve"` {
					t.Errorf("wrong source scope: %s", raw)
				}
				proof := cacheFixture(t, frame{Body: raw}, "fresh", nil)
				w.Write(proof.Body)
			}))
			defer remote.Close()
			legacyCacheEndpoint(t, remote.URL, 0, &oldRequests)
			transport := &Transport{Direct: http.DefaultTransport}
			for i := 0; i < 2; i++ {
				// Include a non-rewindable body: classification must preserve it.
				req, _ := http.NewRequest("POST", remote.URL+"/auth", io.NopCloser(strings.NewReader(`{"command":"retrieve"}`)))
				req.Header.Set("X-Engine", engine)
				res, err := transport.RoundTrip(req)
				if err != nil {
					t.Fatal(err)
				}
				raw, _ := io.ReadAll(res.Body)
				res.Body.Close()
				if res.StatusCode != 200 || res.Header.Get("X-Cxx-Cache-Protocol") != "2" || !strings.Contains(string(raw), `"content":"fresh"`) {
					t.Fatalf("launch read: status=%d body=%s", res.StatusCode, raw)
				}
			}
			if oldRequests.Load() != 0 || confirmations.Load() != 2 || knownRequests.Load() != 1 {
				t.Fatalf("legacy dispatches=%d confirmations=%d manifests=%d", oldRequests.Load(), confirmations.Load(), knownRequests.Load())
			}
		})
	}
}

func TestLegacyOwnerAmbiguousAdmissionIsNotReplayed(t *testing.T) {
	var oldRequests, admissions atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		admissions.Add(1)
		raw, _ := io.ReadAll(r.Body)
		proof := cacheFixture(t, frame{Body: raw}, "fresh", func(p *cacheReply) { p.RequestID = "wrong" })
		w.Write(proof.Body)
	}))
	defer remote.Close()
	legacyCacheEndpoint(t, remote.URL, 0, &oldRequests)
	req, _ := http.NewRequest("POST", remote.URL+"/auth/sessions", strings.NewReader(`{"engine":"codex","session_id":"test"}`))
	res, err := (&Transport{Direct: http.DefaultTransport}).RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 409 || oldRequests.Load() != 0 || admissions.Load() != 1 {
		t.Fatalf("status=%d legacy=%d admissions=%d", res.StatusCode, oldRequests.Load(), admissions.Load())
	}
}

func TestLegacyOwnerBridgeRefusesWarmCacheAfterRevocation(t *testing.T) {
	var oldRequests, checks atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if checks.Add(1) > 1 {
			w.WriteHeader(403)
			io.WriteString(w, `{"code":"host_revoked"}`)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		proof := cacheFixture(t, frame{Body: raw}, "fresh", nil)
		w.Write(proof.Body)
	}))
	defer remote.Close()
	legacyCacheEndpoint(t, remote.URL, 0, &oldRequests)
	for i, want := range []int{200, 403} {
		req, _ := http.NewRequestWithContext(context.Background(), "GET", remote.URL+"/skills?engine=codex", nil)
		res, err := (&Transport{Direct: http.DefaultTransport}).RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != want || i == 1 && strings.Contains(string(raw), "fresh") {
			t.Fatalf("read %d: status=%d body=%s", i, res.StatusCode, raw)
		}
	}
	if oldRequests.Load() != 0 || checks.Load() != 2 {
		t.Fatalf("legacy=%d checks=%d", oldRequests.Load(), checks.Load())
	}
}

func TestProtocol2OwnerMissingReceiptDoesNotTriggerBridgeReplay(t *testing.T) {
	var oldRequests, directRequests atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { directRequests.Add(1) }))
	defer remote.Close()
	legacyCacheEndpoint(t, remote.URL, 2, &oldRequests)
	req, _ := http.NewRequest("POST", remote.URL+"/auth/sessions", strings.NewReader(`{"engine":"codex"}`))
	res, err := (&Transport{Direct: http.DefaultTransport}).RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 409 || oldRequests.Load() != 1 || directRequests.Load() != 0 {
		t.Fatalf("status=%d local=%d direct=%d", res.StatusCode, oldRequests.Load(), directRequests.Load())
	}
}
