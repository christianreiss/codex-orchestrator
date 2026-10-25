package agentbus

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/google/uuid"
	"golang.org/x/net/websocket"
)

// Exercise the connection-owned receiver loop, rather than the legacy HTTP
// heartbeat path: source changes arrive only through this Unix state stream.
func receiverSourceStream(t *testing.T, sources []string) (string, func([]string), <-chan string) {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "state.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	changes := make(chan []string, 8)
	gates := make(chan string, 16)
	server := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
		defer ws.Close()
		var open communicator.StateFrame
		if websocket.JSON.Receive(ws, &open) != nil {
			return
		}
		frame := communicator.StateFrame{Type: "state_snapshot", Protocol: 1, StreamID: open.StreamID, OwnerEpoch: uuid.NewString()}
		send := func(revision int, current []string) error {
			frame.Revision = strconv.Itoa(revision)
			frame.Payload, _ = json.Marshal(map[string]any{"ownership_mode": "connection", "work_revision": frame.Revision, "sources": current})
			return websocket.JSON.Send(ws, frame)
		}
		if send(1, sources) != nil {
			return
		}
		readDone := make(chan struct{})
		go func() {
			defer close(readDone)
			for {
				var received communicator.StateFrame
				if websocket.JSON.Receive(ws, &received) != nil {
					return
				}
				if received.Type == "state_update" {
					var update struct {
						Gate struct {
							State string `json:"state"`
						} `json:"gate"`
					}
					if json.Unmarshal(received.Payload, &update) == nil {
						gates <- update.Gate.State
					}
				}
			}
		}()
		for revision := 2; ; revision++ {
			select {
			case <-readDone:
				return
			case next := <-changes:
				frame.Type = "state_delta"
				if send(revision, next) != nil {
					return
				}
			}
		}
	})}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	return socket, func(next []string) { changes <- next }, gates
}

func sourceReceiver(t *testing.T, socket string, claim func(string), pendingPortal bool) *autoReceiver {
	t.Helper()
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	client := &sessionClient{id: "session", socket: socket, http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		body := `{}`
		switch {
		case strings.HasSuffix(req.URL.Path, "/native"):
			body = `{"native_session_id":"native"}`
		case strings.HasSuffix(req.URL.Path, "/register"):
			body = `{"sources":["peer","portal"],"capabilities":{"control_state_protocol":1},"binding_generation":1}`
		case strings.HasSuffix(req.URL.Path, "/heartbeat"):
			t.Error("connection-owned receiver fell back to HTTP heartbeat")
		case strings.HasSuffix(req.URL.Path, "/claim"):
			var input struct {
				Source string `json:"source"`
			}
			if json.NewDecoder(req.Body).Decode(&input) != nil {
				t.Error("invalid claim")
			}
			claim(input.Source)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}}
	r := &autoReceiver{client: client, tracker: newChannelTracker(client)}
	r.tracker.receiver = r
	if pendingPortal {
		r.pendingPortal = map[string]any{"message_id": "portal"}
		r.portalReplyBody = map[string]any{"client_event_id": "receiver:portal"}
	}
	var deliveries atomic.Int32
	r.output = &mcpWriter{w: receiverHealthWriter{r: r, deliveries: &deliveries}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- r.connection(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("receiver did not stop")
		}
	})
	return r
}

func TestReceiverStateSourceExpansionClaimsEveryCurrentSource(t *testing.T) {
	socket, change, _ := receiverSourceStream(t, []string{"peer"})
	claims := make(chan string, 8)
	sourceReceiver(t, socket, func(source string) { claims <- source }, false)
	select {
	case <-claims:
	case <-time.After(2 * time.Second):
		t.Fatal("initial source was not claimed")
	}
	// Drain the initial finite claim budget before enabling Portal. There is no
	// subsequent work revision to rescue a source missed by this transition.
	for settled := false; !settled; {
		select {
		case <-claims:
		case <-time.After(100 * time.Millisecond):
			settled = true
		}
	}
	change([]string{"peer", "portal"})
	seen := map[string]bool{}
	deadline := time.After(2 * time.Second)
	for len(seen) < 2 {
		select {
		case source := <-claims:
			seen[source] = true
		case <-deadline:
			t.Fatalf("source expansion did not check every current queue: %v", seen)
		}
	}
}

func TestReceiverStatePortalClosureReleasesPeerGate(t *testing.T) {
	socket, change, gates := receiverSourceStream(t, []string{"peer", "portal"})
	claims := make(chan string, 8)
	r := sourceReceiver(t, socket, func(source string) { claims <- source }, true)
	select {
	case gate := <-gates:
		if gate != "portal_pending" {
			t.Fatalf("initial gate = %q", gate)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("receiver did not publish its held Portal gate")
	}
	change([]string{"peer"})
	select {
	case source := <-claims:
		if source != "peer" {
			t.Fatalf("claimed disabled source %q", source)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("closed Portal source kept independent peer reception blocked")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pendingPortal != nil || r.portalReplyBody != nil {
		t.Fatal("closed Portal retained local delivery ownership")
	}
}
