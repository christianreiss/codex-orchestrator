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
