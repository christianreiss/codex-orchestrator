package communicator

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// A broken local owner must not block the reads that repair it, while every
// other managed request keeps failing closed.
func TestBrokenOwnerAllowsOnlyVerifiedSelfHealReads(t *testing.T) {
	base := "https://coco.example/api"
	registry.Store(base, &endpoint{base: base, socket: "/nonexistent/control.sock", setupErr: errors.New("unsafe communicator runtime directory")})
	t.Cleanup(func() { registry.Delete(base) })
	var direct []string
	transport := &Transport{Direct: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		direct = append(direct, r.Method+" "+r.URL.Path)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})}
	for _, path := range []string{"/api/wrapper/v2/config?engine=codex", "/api/wrapper/v2/bin/cxx/linux-amd64/v0.9.75/cxx", "/api/wrapper/v2/download?platform=linux-amd64"} {
		req, _ := http.NewRequest("GET", "https://coco.example"+path, nil)
		if res, err := transport.RoundTrip(req); err != nil || res.StatusCode != 200 {
			t.Fatalf("self-heal read %s blocked: %v", path, err)
		}
	}
	for _, c := range []struct{ method, path string }{{"GET", "/api/versions"}, {"POST", "/api/auth"}, {"POST", "/api/wrapper/v2/config"}, {"GET", "/api/mcp"}, {"GET", "/api/wrapper/v2/meta"}} {
		req, _ := http.NewRequest(c.method, "https://coco.example"+c.path, nil)
		if _, err := transport.RoundTrip(req); err == nil {
			t.Fatalf("%s %s bypassed a broken communicator", c.method, c.path)
		}
	}
	if len(direct) != 3 {
		t.Fatal("unexpected direct traffic", direct)
	}
}

// HTTPS transfers never use the control connection and must not wait for it.
func TestTransfersDoNotWaitForControlConnection(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("artifact"))
	}))
	defer upstream.Close()
	s := &server{cfg: &config.Config{Orchestrator: config.Orchestrator{BaseURL: upstream.URL, APIKey: "k"}}, calls: map[string]*sharedCall{}}
	started := time.Now()
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/wrapper/v2/download?platform=linux-amd64", nil))
	if w.Code != 200 || w.Body.String() != "artifact" || time.Since(started) > 5*time.Second {
		t.Fatal("transfer waited for the control connection", w.Code, w.Body.String(), time.Since(started))
	}
	// The canonical bakery URL a signed config carries is a transfer too.
	started = time.Now()
	w = httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/wrapper/v2/bin/cxx/linux-amd64/v0.9.75/cxx", nil))
	if w.Code != 200 || w.Body.String() != "artifact" || time.Since(started) > 5*time.Second {
		t.Fatal("bakery binary not sent as an HTTPS transfer", w.Code, w.Body.String(), time.Since(started))
	}
}
