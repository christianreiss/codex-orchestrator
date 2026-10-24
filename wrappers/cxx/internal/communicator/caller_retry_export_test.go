package communicator

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"golang.org/x/net/websocket"
)

// Test-only bridge: the persona clients import communicator, so caller tests
// must use the external package to avoid an import cycle. Only owner startup
// and lease maintenance are bypassed; HTTP, Unix transport and WS are real.
type CallerRetryFrame = frame

func SetCallerStateRequired(t *testing.T, base string) {
	t.Helper()
	ep := endpointFor(base)
	ep.mu.Lock()
	previous := ep.anchor
	ep.anchor = &config.Config{Orchestrator: config.Orchestrator{CommunicatorStateProtocol: 1}}
	ep.mu.Unlock()
	t.Cleanup(func() { ep.mu.Lock(); ep.anchor = previous; ep.mu.Unlock() })
}

func NewCallerRetryOwner(t *testing.T, remote func(*websocket.Conn, CallerRetryFrame), transfer http.Handler, loseLocal bool) (string, *atomic.Int32, func()) {
	t.Helper()
	upstream := httptest.NewServer(transfer)
	t.Cleanup(upstream.Close)
	s := &server{cfg: &config.Config{Orchestrator: config.Orchestrator{BaseURL: upstream.URL, APIKey: "test-host"}}, calls: map[string]*sharedCall{}}
	reconnect := func() {
		c := testConnection(t, remote)
		s.mu.Lock()
		s.conn = c
		s.mu.Unlock()
	}
	reconnect()
	// A short private directory avoids sun_path truncation, even with long test names.
	dir, err := os.MkdirTemp("", "cxx-retry-")
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
		if !loseLocal {
			s.ServeHTTP(w, r)
			return
		}
		// Complete the operation, then lose its local HTTP reply after dispatch.
		s.ServeHTTP(httptest.NewRecorder(), r)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		conn.Close()
	}))
	local.Listener.Close()
	local.Listener = listener
	local.Start()
	t.Cleanup(local.Close)
	ep := &endpoint{base: upstream.URL, socket: socket}
	ep.once.Do(func() {}) // No background lease or re-exec in this controlled owner.
	registry.Store(upstream.URL, ep)
	t.Cleanup(func() { registry.Delete(upstream.URL) })
	return upstream.URL, &attempts, reconnect
}
