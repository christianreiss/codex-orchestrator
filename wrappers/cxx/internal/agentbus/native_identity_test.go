package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

// The private app-server can replace its root without replacing the wrapper.
// This fixture never starts or resumes a thread to discover that replacement.
type nativeIdentityServer struct {
	mu         sync.Mutex
	roots      map[string]any
	methods    []string
	nextCursor string
}

func serveNativeIdentities(t *testing.T, roots map[string]any) (string, *nativeIdentityServer) {
	t.Helper()
	f := &nativeIdentityServer{roots: roots}
	path := filepath.Join(t.TempDir(), "native.sock")
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	s := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		for {
			var req struct {
				ID     int            `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if websocket.JSON.Receive(ws, &req) != nil {
				return
			}
			if req.Method == "initialized" {
				continue
			}
			f.mu.Lock()
			f.methods = append(f.methods, req.Method)
			out := map[string]any{}
			switch req.Method {
			case "initialize":
			case "thread/loaded/list":
				ids := []string{}
				for id := range f.roots {
					ids = append(ids, id)
				}
				out["data"] = ids
				out["nextCursor"] = f.nextCursor
			case "thread/read":
				out["thread"] = map[string]any{"id": req.Params["threadId"], "source": f.roots[req.Params["threadId"].(string)], "status": map[string]any{"type": "idle"}}
			case "thread/turns/list":
				out["data"] = []any{}
			case "turn/steer":
				if len(req.Params) != 0 {
					t.Error("valid steering request during identity discovery")
				}
				f.mu.Unlock()
				if websocket.JSON.Send(ws, map[string]any{"id": req.ID, "error": map[string]any{"code": -32602, "message": "missing required fields"}}) != nil {
					return
				}
				continue
			default:
				t.Errorf("unexpected native operation: %s", req.Method)
			}
			f.mu.Unlock()
			if websocket.JSON.Send(ws, map[string]any{"id": req.ID, "result": out}) != nil {
				return
			}
		}
	})}
	go s.Serve(l)
	t.Cleanup(func() { s.Close() })
	return path, f
}

func TestNativeIdentityFollowsOnlyAnUnambiguousReplacementRoot(t *testing.T) {
	for _, tc := range []struct {
		name       string
		roots      map[string]any
		want       string
		nextCursor string
	}{
		{"replacement", map[string]any{"new": "vscode"}, "new", ""},
		{"existing root wins", map[string]any{"old": "cli", "new": "vscode"}, "old", ""},
		{"unloaded gap", map[string]any{}, "", ""},
		{"ambiguous roots", map[string]any{"new": "cli", "other": "vscode"}, "", ""},
		{"subagent is not a root", map[string]any{"child": map[string]any{"subAgent": "review"}}, "", ""},
		{"partial roster is not unique proof", map[string]any{"new": "vscode"}, "", "next-page"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path, fixture := serveNativeIdentities(t, tc.roots)
			fixture.nextCursor = tc.nextCursor
			q, err := openNativeQueue(context.Background(), path)
			if err != nil {
				t.Fatal(err)
			}
			defer q.close()
			q.thread = "old"
			id, err := q.identity()
			if tc.want == "" {
				if err == nil || q.thread != "old" {
					t.Fatalf("uncertain identity changed binding: %q %q %v", id, q.thread, err)
				}
			} else if err != nil || id != tc.want || q.thread != tc.want {
				t.Fatalf("identity=%q bound=%q err=%v", id, q.thread, err)
			}
		})
	}
}

func TestCodexReplacementFencesOldWorkBeforeRegistration(t *testing.T) {
	path, _ := serveNativeIdentities(t, map[string]any{"new-native": "vscode"})
	t.Setenv("CXX_CODEX_SOCKET", path)
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "codex")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	abandoned, registered := 0, false
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body := `{}`
		switch {
		case strings.HasSuffix(req.URL.Path, "/ack"):
			var args map[string]any
			_ = json.NewDecoder(req.Body).Decode(&args)
			if args["outcome"] != "ambiguous" || args["error_code"] != "native_session_changed" {
				t.Errorf("old work not fenced: %v", args)
			}
			abandoned++
		case strings.HasSuffix(req.URL.Path, "/register"):
			var args map[string]any
			_ = json.NewDecoder(req.Body).Decode(&args)
			if args["native_session_id"] != "new-native" || abandoned != 1 {
				t.Errorf("registration preceded fencing: %v abandoned=%d", args, abandoned)
			}
			registered = true
			body = `{"sources":["peer"]}`
		case strings.HasSuffix(req.URL.Path, "/heartbeat"):
			cancel()
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	tracker := newChannelTracker(client)
	tracker.track(ctx, "old-message", "old-claim")
	r := &autoReceiver{client: client, tracker: tracker, boundNativeID: "old-native", pendingPortal: map[string]any{"message_id": "old-portal"}}
	_ = r.connection(ctx)
	if !registered || r.boundNativeID != "new-native" || tracker.get("old-message") != nil || r.pendingPortal != nil {
		t.Fatalf("replacement did not register cleanly: registered=%v bound=%q abandoned=%d", registered, r.boundNativeID, abandoned)
	}
}

func TestCodexHeartbeatStopsBeforeUsingAReplacedThread(t *testing.T) {
	path, fixture := serveNativeIdentities(t, map[string]any{"old-native": "cli"})
	t.Setenv("CXX_CODEX_SOCKET", path)
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "codex")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	client := &sessionClient{id: "session", http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body := `{}`
		if strings.HasSuffix(req.URL.Path, "/register") {
			fixture.mu.Lock()
			fixture.roots = map[string]any{"new-native": "vscode"}
			fixture.mu.Unlock()
			body = `{"sources":["peer"]}`
		}
		if strings.HasSuffix(req.URL.Path, "/heartbeat") {
			t.Error("heartbeat certified the obsolete binding")
			cancel()
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	r := &autoReceiver{client: client, tracker: newChannelTracker(client), boundNativeID: "old-native"}
	err := r.connection(ctx)
	if err == nil || err.Error() != "native session changed" || r.boundNativeID != "old-native" {
		t.Fatalf("old connection continued: bound=%q err=%v", r.boundNativeID, err)
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	for _, method := range fixture.methods {
		if method == "thread/turns/list" || method == "thread/name/set" {
			t.Errorf("old connection used replacement before re-registration: %s", method)
		}
	}
}
