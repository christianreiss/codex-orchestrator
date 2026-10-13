package communicator

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// NewRefusedOwner is the caller-test bridge for a control channel that cannot be
// established: every redial fails. A non-zero status is the server's verdict on the
// handshake (body is what it said); zero is a plain outage. Like NewCallerRetryOwner,
// HTTP and the Unix transport are real; only owner startup and the dial are bypassed.
// It returns the base URL clients use and the count of requests that reached the owner.
func NewRefusedOwner(t *testing.T, status int, code, body string) (string, *atomic.Int32) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("a request that never reached the control channel used HTTPS: %s", r.URL.Path)
	}))
	t.Cleanup(upstream.Close)
	s := &server{
		cfg:            &config.Config{Orchestrator: config.Orchestrator{BaseURL: upstream.URL, APIKey: "test-host"}},
		calls:          map[string]*sharedCall{},
		kick:           make(chan struct{}, 1),
		failures:       3,
		lastAttemptEnd: time.Now(),
	}
	if status != 0 {
		refusal := &handshakeRefusal{Status: status, Code: code, Body: []byte(body), detail: code}
		s.lastError = refusal.Error()
		s.noteFailureLocked(refusal)
	} else {
		s.lastError = "control connection disconnected"
	}
	// Every on-demand redial fails again, as it would against the same server.
	fakeLoop(s, 5*time.Millisecond, false, nil)
	dir, err := os.MkdirTemp("", "cxx-refused-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "owner.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	var attempts atomic.Int32
	local := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		s.ServeHTTP(w, r)
	}))
	local.Listener.Close()
	local.Listener = listener
	local.Start()
	t.Cleanup(local.Close)
	ep := &endpoint{base: upstream.URL, socket: socket}
	ep.once.Do(func() {})
	registry.Store(upstream.URL, ep)
	t.Cleanup(func() { registry.Delete(upstream.URL) })
	return upstream.URL, &attempts
}
