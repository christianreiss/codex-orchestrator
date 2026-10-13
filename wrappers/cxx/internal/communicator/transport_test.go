package communicator

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"golang.org/x/net/websocket"
)

func testConnection(t *testing.T, handler func(*websocket.Conn, frame)) *connection {
	t.Helper()
	remote := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		for {
			var f frame
			if websocket.JSON.Receive(ws, &f) != nil {
				return
			}
			handler(ws, f)
		}
	}))
	t.Cleanup(remote.Close)
	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: remote.URL, APIKey: "test"}}
	transport, err := directTransport(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ws, err := dial(context.Background(), cfg, transport)
	if err != nil {
		t.Fatal(err)
	}
	c := &connection{ws: ws, pending: map[string]chan frame{}, done: make(chan struct{}), ready: make(chan struct{})}
	go c.receive()
	t.Cleanup(func() { ws.Close(); <-c.done })
	return c
}
func TestConcurrentRepliesKeepIdentity(t *testing.T) {
	var writes sync.Mutex
	c := testConnection(t, func(ws *websocket.Conn, f frame) {
		go func() {
			time.Sleep(time.Duration(len(f.Path)%7) * time.Millisecond)
			writes.Lock()
			defer writes.Unlock()
			websocket.JSON.Send(ws, frame{ID: f.ID, Status: 200, Body: []byte(f.Path)})
		}()
	})
	var wg sync.WaitGroup
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			path := "/host/" + strings.Repeat("x", n+1)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			reply, unknown, err := c.request(ctx, frame{Method: "POST", Path: path})
			if err != nil || unknown || string(reply.Body) != path {
				t.Errorf("misrouted response: %v %v %s", err, unknown, reply.Body)
			}
		}(i)
	}
	wg.Wait()
}
func TestLostWriteResponseIsUnknownAndNeverReplayed(t *testing.T) {
	var calls atomic.Int32
	c := testConnection(t, func(ws *websocket.Conn, f frame) { calls.Add(1); ws.Close() })
	_, unknown, err := c.request(context.Background(), frame{Method: "POST", Path: "/host/task"})
	if err == nil || !unknown || calls.Load() != 1 {
		t.Fatalf("lost reply = %v, unknown %v, calls %d", err, unknown, calls.Load())
	}
	rec := httptest.NewRecorder()
	writeUnavailable(rec, unknown)
	if rec.Code != 409 || !strings.Contains(rec.Body.String(), "communicator_outcome_unknown") {
		t.Fatal(rec.Code, rec.Body.String())
	}
}
func TestOnlyIdenticalReadScopesCoalesce(t *testing.T) {
	var calls atomic.Int32
	c := testConnection(t, func(ws *websocket.Conn, f frame) {
		calls.Add(1)
		time.Sleep(70 * time.Millisecond)
		websocket.JSON.Send(ws, frame{ID: f.ID, Status: 200, Body: f.Body})
	})
	s := &server{calls: map[string]*sharedCall{}}
	f := frame{Method: "POST", Path: "/config/retrieve", Headers: map[string]string{"x-engine": "codex"}, Body: []byte(`{"home":"/first"}`)}
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, _, err := s.coalesce(context.Background(), c, f); err != nil {
				t.Error(err)
			}
		}()
	}
	close(start)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("expected one request, got %d", calls.Load())
	}
	f.Headers = map[string]string{"x-engine": "claude"}
	if _, _, err := s.coalesce(context.Background(), c, f); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatal("different engine shared an auth scope")
	}
	for _, unsafe := range []frame{{Method: "POST", Path: "/auth"}, {Method: "POST", Path: "/mcp"}, {Method: "POST", Path: "/sync/bootstrap", Body: []byte(`{"include_auth":true}`)}, {Method: "POST", Path: "/sync/bootstrap", Body: []byte(`{"include_auth":false,"auth_candidate":{}}`)}} {
		if coalescible(unsafe) {
			t.Fatalf("unsafe cache: %+v", unsafe)
		}
	}
}
func TestSocketDirectoryIsolation(t *testing.T) {
	root := t.TempDir()
	os.Chmod(root, 0700)
	t.Setenv("XDG_RUNTIME_DIR", root)
	a, err := socketPath("https://one.example")
	if err != nil {
		t.Fatal(err)
	}
	b, err := socketPath("https://two.example")
	if err != nil || a == b {
		t.Fatal(a, b, err)
	}
	info, _ := os.Stat(filepath.Dir(a))
	if info.Mode().Perm() != 0700 {
		t.Fatal("directory accessible by other users")
	}
	os.Chmod(filepath.Dir(a), 0755)
	if _, err := socketPath("https://one.example"); err == nil {
		t.Fatal("unsafe directory accepted")
	}
}

// A launcher that scrubs XDG_RUNTIME_DIR must reach the same owner socket.
func TestSocketPathIgnoresMissingRuntimeEnvironment(t *testing.T) {
	// A short root: a long t.TempDir() would legitimately trigger the
	// socket-length fallback and make the three results indistinguishable.
	session, err := os.MkdirTemp("", "cc-sess-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(session) })
	os.Chmod(session, 0700)
	previous := sessionRuntimeRoot
	sessionRuntimeRoot = func() string { return session }
	t.Cleanup(func() { sessionRuntimeRoot = previous })
	t.Setenv("XDG_RUNTIME_DIR", session)
	withEnv, err := socketPath("https://one.example")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_RUNTIME_DIR", "")
	withoutEnv, err := socketPath("https://one.example")
	if err != nil || withEnv != withoutEnv {
		t.Fatal(withEnv, withoutEnv, err)
	}
	os.Chmod(session, 0755)
	fallback, err := socketPath("https://one.example")
	if err != nil || fallback == withEnv {
		t.Fatal("unsafe session runtime directory used", fallback, err)
	}
	os.Chmod(session, 0700)
}
func TestProviderRequestsUseOriginalTransport(t *testing.T) {
	var called bool
	direct := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		called = true
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("provider"))}, nil
	})
	req, _ := http.NewRequest("POST", "https://provider.example/v1/responses", nil)
	_, err := (&Transport{Direct: direct}).RoundTrip(req)
	if err != nil || !called {
		t.Fatal("provider traffic intercepted", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestControlSocketStatusDoesNotExposeCredentials(t *testing.T) {
	s := &server{cfg: &config.Config{Orchestrator: config.Orchestrator{APIKey: "secret-value"}}, calls: map[string]*sharedCall{}}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/_comm/status", nil))
	var result map[string]any
	if json.Unmarshal(w.Body.Bytes(), &result) != nil || strings.Contains(w.Body.String(), "secret-value") {
		t.Fatal(w.Body.String())
	}
}

func TestDaemonChannelSharesControlConnection(t *testing.T) {
	c := testConnection(t, func(ws *websocket.Conn, f frame) {
		if f.Type == "daemon" {
			_ = websocket.JSON.Send(ws, frame{Type: "daemon_event", Payload: f.Payload})
		}
	})
	s := &server{conn: c, calls: map[string]*sharedCall{}}
	local := httptest.NewServer(s)
	defer local.Close()
	ws, err := websocket.Dial(strings.Replace(local.URL, "http://", "ws://", 1)+"/_comm/daemon", "", local.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	ws.SetDeadline(time.Now().Add(time.Second))
	value := map[string]any{"id": "original-daemon-request", "type": "heartbeat", "payload": map[string]any{"active_sessions": []string{}}}
	if err := websocket.JSON.Send(ws, value); err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := websocket.JSON.Receive(ws, &result); err != nil {
		t.Fatal(err)
	}
	if result["id"] != value["id"] || result["type"] != "heartbeat" {
		t.Fatal("daemon identity lost", result)
	}
}

func TestSyncScopesKeepEngineAndEnvironmentBoundaries(t *testing.T) {
	s := &server{jobs: map[string]syncJob{}, jobRefs: map[string]int{}}
	for _, engine := range []string{"codex", "claude", "grok"} {
		req := httptest.NewRequest("POST", "/_comm/lease", strings.NewReader(`[{"engine":"`+engine+`","config":"/signed","env":{"HOME":"/one"}}]`))
		ids, err := s.registerJobs(req)
		if err != nil || len(ids) != 1 {
			t.Fatal(ids, err)
		}
	}
	if len(s.jobs) != 3 {
		t.Fatal("engine scopes collapsed")
	}
	bad := httptest.NewRequest("POST", "/_comm/lease", strings.NewReader(`[{"engine":"codex","env":{"LD_PRELOAD":"/bad"}}]`))
	if _, err := s.registerJobs(bad); err == nil {
		t.Fatal("arbitrary subprocess environment accepted")
	}
}

func TestLeaseRemovesScopeWhenClientDisconnects(t *testing.T) {
	s := &server{jobs: map[string]syncJob{}, jobRefs: map[string]int{}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("POST", "/_comm/lease", strings.NewReader(`[{"engine":"codex","config":"/signed","env":{"HOME":"/one"}}]`)).WithContext(ctx)
	done := make(chan struct{})
	go func() { s.ServeHTTP(httptest.NewRecorder(), req); close(done) }()
	deadline := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		ready := s.leases == 1 && len(s.jobs) == 1
		s.mu.Unlock()
		if ready {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("lease not registered")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	<-done
	if s.leases != 0 || len(s.jobs) != 0 || len(s.jobRefs) != 0 {
		t.Fatal("disconnected scope retained", s.leases, s.jobs, s.jobRefs)
	}
}

func TestWatchdogStreamFlushesBeforeUpstreamCloses(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: heartbeat\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer upstream.Close()
	s := &server{cfg: &config.Config{Orchestrator: config.Orchestrator{BaseURL: upstream.URL}}}
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.download(w, r, nil) }))
	defer local.Close()
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get(local.URL + "/host/agent-sessions/test/watchdog/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	line := make([]byte, len("data: heartbeat\n\n"))
	if _, err := io.ReadFull(response.Body, line); err != nil {
		t.Fatal(err)
	}
	if string(line) != "data: heartbeat\n\n" {
		t.Fatalf("unexpected frame: %q", line)
	}
}

// A stalled daemon consumer loses only its own stream, never the shared
// control connection that other engines' requests are using.
func TestDaemonOverflowKeepsControlConnection(t *testing.T) {
	c := testConnection(t, func(ws *websocket.Conn, f frame) {
		if f.Type == "request" && f.Path == "/flood" {
			for i := 0; i < 100; i++ {
				_ = websocket.JSON.Send(ws, frame{Type: "daemon_event", Payload: json.RawMessage(`{}`)})
			}
		}
		if f.Type == "request" {
			_ = websocket.JSON.Send(ws, frame{ID: f.ID, Status: 200})
		}
	})
	stalled := make(chan json.RawMessage, 64)
	c.mu.Lock()
	c.daemon = stalled
	c.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, _, err := c.request(ctx, frame{Method: "GET", Path: "/flood"}); err != nil {
		t.Fatal(err)
	}
	if result, _, err := c.request(ctx, frame{Method: "GET", Path: "/after"}); err != nil || result.Status != 200 {
		t.Fatal("control connection lost after daemon overflow", result, err)
	}
	select {
	case <-c.done:
		t.Fatal("control connection closed")
	default:
	}
	c.mu.Lock()
	detached := c.daemon == nil
	c.mu.Unlock()
	drained := 0
	for range stalled {
		drained++
	}
	if !detached || drained != 64 {
		t.Fatal("stalled daemon stream not detached", detached, drained)
	}
}

func TestHTTPSOperationsRetainHostBinding(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(r.Header)
	}))
	defer upstream.Close()
	s := &server{cfg: &config.Config{Orchestrator: config.Orchestrator{BaseURL: upstream.URL, APIKey: "bound-host"}}}
	for _, path := range []string{"/wrapper/v2/download", "/host/agent-sessions/test/attachments/get", "/host/agent-sessions/test/watchdog/stream", "/mcp", "/mcp/", "/mcp//"} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest("POST", path, nil)
			req.Header.Set("X-API-Key", "foreign-host")
			req.Header.Set("Authorization", "Bearer own-mcp-session")
			req.Header.Set("Cookie", "admin=secret")
			req.Header.Set("X-Forwarded-For", "127.0.0.1")
			req.Header.Set("X-Agent-Bridge-Token", "own-session")
			req.Header.Set("X-Engine", "claude")
			w := httptest.NewRecorder()
			s.download(w, req, nil)
			var h http.Header
			if err := json.Unmarshal(w.Body.Bytes(), &h); err != nil {
				t.Fatal(err)
			}
			if h.Get("X-API-Key") != "bound-host" || h.Get("Cookie") != "" || h.Get("X-Forwarded-For") != "" {
				t.Fatalf("authority changed: %v", h)
			}
			if h.Get("X-Engine") != "claude" || h.Get("X-Agent-Bridge-Token") != "own-session" {
				t.Fatalf("session identity lost: %v", h)
			}
			if strings.TrimRight(path, "/") == "/mcp" {
				if h.Get("Authorization") != "Bearer own-mcp-session" || h.Get("X-Cxx-Communicator") != "1" {
					t.Fatalf("MCP binding missing: %v", h)
				}
			} else if h.Get("Authorization") != "" {
				t.Fatal("non-MCP bearer forwarded")
			}
		})
	}
}

func TestHTTPSOperationsRejectForbiddenRoutes(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer upstream.Close()
	s := &server{cfg: &config.Config{Orchestrator: config.Orchestrator{BaseURL: upstream.URL}}, fallback: true}
	for _, path := range []string{"/admin/users", "/v1/responses", "/host/../admin/users", "/host/%2e%2e/admin/users", "/host/daemon/connect", "/host/communicator/connect", "/host/daemon/connect/", "/host/daemon/connect//", "/host/echo/stream/"} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest("POST", path, nil))
		if w.Code != http.StatusForbidden {
			t.Errorf("%s accepted: %d", path, w.Code)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("forbidden requests reached HTTPS: %d", calls.Load())
	}
}
