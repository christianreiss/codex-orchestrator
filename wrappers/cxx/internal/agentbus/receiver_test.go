package agentbus

import (
	"context"
	"encoding/json"
	"fmt"
	"golang.org/x/net/websocket"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentportal"
)

type rewriteTransport struct{ server *httptest.Server }

func (r rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = "http"
	req.URL.Host = strings.TrimPrefix(r.server.URL, "http://")
	return http.DefaultTransport.RoundTrip(req)
}

func TestAutomaticListenDoesNotClaimOrCompleteNativeDeliveries(t *testing.T) {
	c := &sessionClient{}
	tracker := newChannelTracker(c)
	tracker.receiver = &autoReceiver{client: c}
	tracker.items["pending"] = &channelPending{}
	out, err := agentListen(context.Background(), c, tracker, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if out["status"] != "automatic" || len(tracker.items) != 1 {
		t.Fatal("manual listen competed with native receiver")
	}
}

// A receiver can look "ready" from MCP-pipe liveness and hook identity alone
// while Claude Code's channel gate silently fell back -- exactly the trap the
// fleet's channel runbook warns about. Doctor must be able to tell the two
// apart from the marker agentportal leaves beside the plugin it built.
func TestChannelPolicyForReadsTheMarkerAgentportalWrites(t *testing.T) {
	dir := t.TempDir()
	socket := filepath.Join(dir, "portal.sock")
	if got := channelPolicyFor(socket); got != "" {
		t.Fatalf("no marker yet should report no opinion, got %q", got)
	}
	if got := channelPolicyFor(""); got != "" {
		t.Fatalf("empty socket should report no opinion, got %q", got)
	}
	plugin := filepath.Join(dir, agentportal.PluginName)
	if err := os.MkdirAll(plugin, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plugin, agentportal.ChannelPolicyMarker), []byte("fallback"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := channelPolicyFor(socket); got != "fallback" {
		t.Fatalf("expected fallback, got %q", got)
	}
}

func TestPortalReplyRequiresOwnedMessage(t *testing.T) {
	r := &autoReceiver{pendingPortal: map[string]any{"message_id": "owned"}}
	if _, err := r.reply(context.Background(), map[string]any{"message_id": "another", "content": "reply"}); err == nil {
		t.Fatal("accepted unrelated portal reply")
	}
}

func TestChannelDeliveryPreservesFullContentAndMessageID(t *testing.T) {
	var output strings.Builder
	r := &autoReceiver{output: &mcpWriter{w: &output}}
	text := "Peer input with \"quotes\"\nand a newline"
	if err := r.deliver("delivery", text); err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Method string `json:"method"`
		Params struct {
			Content string            `json:"content"`
			Meta    map[string]string `json:"meta"`
		} `json:"params"`
	}
	if err := json.Unmarshal([]byte(output.String()), &wire); err != nil {
		t.Fatal(err)
	}
	if wire.Method != "notifications/claude/channel" || wire.Params.Content != text || wire.Params.Meta["message_id"] != "delivery" {
		t.Fatal("delivery changed")
	}
}

// Exercise real adapter loops: health and reconnects must never become model turns.
func TestReceiverHealthAndReconnectsDoNotDeliverChatProbes(t *testing.T) {
	for _, engine := range []string{"codex", "claude"} {
		for _, legacyProbe := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/legacy=%v", engine, legacyProbe), func(t *testing.T) {
				t.Setenv("CXX_AGENT_PORTAL_ENGINE", engine)
				var nativeDeliveries atomic.Int32
				if engine == "codex" {
					socket := filepath.Join(t.TempDir(), "native.sock")
					listener, err := net.Listen("unix", socket)
					if err != nil {
						t.Fatal(err)
					}
					server := &http.Server{Handler: websocket.Handler(func(ws *websocket.Conn) {
						defer ws.Close()
						for {
							var req struct {
								ID     int    `json:"id"`
								Method string `json:"method"`
							}
							if websocket.JSON.Receive(ws, &req) != nil {
								return
							}
							if req.Method == "initialized" {
								continue
							}
							result := map[string]any{}
							switch req.Method {
							case "initialize":
							case "thread/loaded/list":
								result["data"] = []string{"native"}
							case "thread/read":
								result["thread"] = map[string]any{"id": "native", "source": "cli", "status": map[string]any{"type": "idle"}}
							default:
								nativeDeliveries.Add(1)
							}
							if websocket.JSON.Send(ws, map[string]any{"id": req.ID, "result": result}) != nil {
								return
							}
						}
					})}
					go server.Serve(listener)
					defer server.Close()
					t.Setenv("CXX_CODEX_SOCKET", socket)
				}
				generations := map[string]bool{}
				for attempt := 0; attempt < 2; attempt++ {
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					var heartbeats atomic.Int32
					var claims atomic.Int32
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
						var args map[string]any
						_ = json.NewDecoder(req.Body).Decode(&args)
						out := map[string]any{}
						switch path.Base(req.URL.Path) {
						case "native":
							out["native_session_id"] = "native"
						case "register":
							generation := stringArg(args, "generation")
							if generations[generation] {
								t.Error("reused receiver generation")
							}
							generations[generation] = true
							out["sources"] = []string{"peer", "portal"}
						case "heartbeat":
							heartbeats.Add(1)
						case "claim":
							if legacyProbe {
								out["probe"] = map[string]any{"id": "old", "nonce": "old"}
							}
							if claims.Add(1) == 2 {
								cancel()
							}
						case "status", "stop":
						default:
							t.Errorf("unexpected receiver operation %s", req.URL.Path)
						}
						_ = json.NewEncoder(w).Encode(out)
					}))
					c := &sessionClient{id: "session", http: &http.Client{Transport: rewriteTransport{server: server}}}
					r := &autoReceiver{client: c, tracker: newChannelTracker(c)}
					r.output = &mcpWriter{w: receiverHealthWriter{r: r, deliveries: &nativeDeliveries}}
					err := r.connection(ctx)
					cancel()
					server.Close()
					if legacyProbe && (err == nil || !strings.Contains(err.Error(), "update the server")) {
						t.Fatalf("legacy probe not refused: %v", err)
					}
					if !legacyProbe && claims.Load() != 2 {
						t.Fatalf("sources not polled: %v", err)
					}
					if heartbeats.Load() == 0 {
						t.Fatal("no background heartbeat")
					}
				}
				if nativeDeliveries.Load() != 0 {
					t.Fatal("health checks delivered a model turn")
				}
			})
		}
	}
}

type receiverHealthWriter struct {
	r          *autoReceiver
	deliveries *atomic.Int32
}

func (w receiverHealthWriter) Write(data []byte) (int, error) {
	var msg struct {
		Method string `json:"method"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		return 0, err
	}
	if msg.Method == "ping" {
		w.r.mu.Lock()
		w.r.lastPong = time.Now()
		w.r.mu.Unlock()
	} else {
		w.deliveries.Add(1)
	}
	return len(data), nil
}
