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

func TestReceiverHealthRequiresCurrentSuccessfulPong(t *testing.T) {
	r := &autoReceiver{}
	old := r.beginPing()
	current := r.beginPing()
	for _, wire := range []string{
		fmt.Sprintf(`{"jsonrpc":"2.0","id":%q,"result":{}}`, old),
		fmt.Sprintf(`{"jsonrpc":"2.0","id":%q,"error":{"code":-32601}}`, current),
		fmt.Sprintf(`{"jsonrpc":"2.0","id":%q}`, current),
		fmt.Sprintf(`{"jsonrpc":"2.0","id":%q,"result":null}`, current),
		fmt.Sprintf(`{"jsonrpc":"2.0","id":%q,"result":42}`, current),
		fmt.Sprintf(`{"jsonrpc":"2.0","id":%q,"result":[]}`, current),
		`{"jsonrpc":"2.0","id":"cxx-receiver-health","result":{}}`,
	} {
		r.acceptPong([]byte(wire))
		if !r.lastPong.IsZero() {
			t.Fatalf("invalid health receipt certified reception: %s", wire)
		}
	}
	r.acceptPong([]byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%q,"result":{}}`, current)))
	if r.lastPong.IsZero() || r.pendingPing != "" {
		t.Fatal("current successful response did not complete health attempt")
	}
	seen := r.lastPong
	r.acceptPong([]byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%q,"result":{}}`, current)))
	if !r.lastPong.Equal(seen) {
		t.Fatal("duplicate response extended health freshness")
	}
}

func (r rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = "http"
	req.URL.Host = strings.TrimPrefix(r.server.URL, "http://")
	return http.DefaultTransport.RoundTrip(req)
}

// heldDeliveryServer answers every session call with an empty object and
// records which operations were posted, checking that the held delivery is
// completed under the claim that produced it.
func heldDeliveryServer(t *testing.T, calls *[]string) *sessionClient {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var args map[string]any
		_ = json.NewDecoder(req.Body).Decode(&args)
		op := strings.TrimPrefix(req.URL.Path, "/host/agent-sessions/session/agent-messaging/")
		*calls = append(*calls, op)
		if op == "deliveries/held/ack" && (args["outcome"] != "completed" || args["claim_id"] != "claim") {
			t.Errorf("held delivery acknowledged as %v", args)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{})
	}))
	t.Cleanup(server.Close)
	return &sessionClient{id: "session", http: &http.Client{Transport: rewriteTransport{server: server}}}
}

func holdDelivery(c *sessionClient) *channelTracker {
	tracker := newChannelTracker(c)
	tracker.receiver = &autoReceiver{client: c, tracker: tracker, connected: true, lastBeatOK: time.Now()}
	tracker.items["held"] = &channelPending{claimID: "claim", cancel: func() {}}
	return tracker
}

// The receiver claims only while it holds nothing, and the server leases one
// delivery per address, so a message finished without agent_reply -- a joined
// invite, a WELCOME or NOTED -- wedged reception until its TTL. Listening means
// "done with the previous message" in the automatic lane too, but it still never
// claims: the receiver owns claiming.
func TestAutomaticListenReleasesHeldDeliveryWithoutClaiming(t *testing.T) {
	var calls []string
	c := heldDeliveryServer(t, &calls)
	tracker := holdDelivery(c)
	out, err := agentListen(context.Background(), c, tracker, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if out["status"] != "automatic" {
		t.Fatalf("status = %v", out["status"])
	}
	if len(tracker.items) != 0 {
		t.Fatal("held delivery still blocks the receiver")
	}
	if strings.Join(calls, ",") != "deliveries/held/ack" {
		t.Fatalf("listen posted %v; want only the completion", calls)
	}
}

func TestNativePeerReplyCanFinishWithoutAnOutboundAcknowledgement(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			t.Setenv("CXX_AGENT_PORTAL_ENGINE", engine)
			delivery := map[string]any{"message_id": "held", "kind": "reply", "content": "Austausch beendet."}
			prompt := nativePeerPrompt(delivery)
			if !strings.Contains(prompt, "peer reply, informational by default") || !strings.Contains(prompt, "call agent_listen once, then yield") || !strings.Contains(prompt, "Do not acknowledge an acknowledgement") {
				t.Fatalf("closing reply has no stopping rule: %s", prompt)
			}
			var payload map[string]any
			if err := json.Unmarshal([]byte(strings.SplitN(prompt, "\n", 2)[1]), &payload); err != nil || payload["message_id"] != "held" || payload["content"] != delivery["content"] {
				t.Fatalf("delivery correlation or content changed: %v, %v", payload, err)
			}
			var calls []string
			client := heldDeliveryServer(t, &calls)
			tracker := holdDelivery(client)
			if _, err := callMCPTool(context.Background(), client, tracker, "agent_listen", map[string]any{}); err != nil {
				t.Fatal(err)
			}
			if strings.Join(calls, ",") != "deliveries/held/ack" || len(tracker.items) != 0 {
				t.Fatalf("closing reply must complete without a broker reply: calls=%v, held=%d", calls, len(tracker.items))
			}
		})
	}
}

func TestNativePeerRequestStillSupportsACorrelatedAnswer(t *testing.T) {
	prompt := nativePeerPrompt(map[string]any{"message_id": "held", "kind": "request", "content": "What failed?"})
	if !strings.Contains(prompt, "Use agent_reply with message_id only when an answer is needed") || strings.Contains(prompt, "peer reply, informational by default") {
		t.Fatalf("request lost its reply guidance: %s", prompt)
	}
	var calls []string
	client := heldDeliveryServer(t, &calls)
	tracker := holdDelivery(client)
	if _, err := callMCPTool(context.Background(), client, tracker, "agent_reply", map[string]any{"message_id": "held", "content": "The receiver asked both peers to reply."}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(calls, ",") != "reply,deliveries/held/ack" || len(tracker.items) != 0 {
		t.Fatalf("answer must be stored and its delivery completed: calls=%v, held=%d", calls, len(tracker.items))
	}
}

func TestNativePublicationFinishesWithoutReply(t *testing.T) {
	prompt := nativePeerPrompt(map[string]any{"message_id": "held", "kind": "publication", "content": "PUBLICATION/1 topic=build.ready\nThe build passed."})
	if !strings.Contains(prompt, "informational publication; no reply is required") || !strings.Contains(prompt, "call agent_listen once, then yield") {
		t.Fatal("publication has no terminal delivery guidance")
	}
	var calls []string
	client := heldDeliveryServer(t, &calls)
	tracker := holdDelivery(client)
	if _, err := callMCPTool(context.Background(), client, tracker, "agent_listen", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(calls, ",") != "deliveries/held/ack" || len(tracker.items) != 0 {
		t.Fatalf("publication completion sent another message: calls=%v held=%d", calls, len(tracker.items))
	}
}

// Conference messages are answered in the room, not with agent_reply: an invite
// by joining, a chair's message by speaking. Either must release the delivery.
func TestConferenceAnswersReleaseHeldDelivery(t *testing.T) {
	for _, tc := range []struct {
		tool string
		args map[string]any
		op   string
	}{
		{"agent_conf_join", map[string]any{"conference_id": "room"}, "conf/join"},
		{"agent_conf_say", map[string]any{"conference_id": "room", "content": "HELLO"}, "conf/say"},
	} {
		t.Run(tc.tool, func(t *testing.T) {
			var calls []string
			c := heldDeliveryServer(t, &calls)
			tracker := holdDelivery(c)
			if _, err := callMCPTool(context.Background(), c, tracker, tc.tool, tc.args); err != nil {
				t.Fatal(err)
			}
			if len(tracker.items) != 0 {
				t.Fatal("held delivery still blocks the receiver")
			}
			if strings.Join(calls, ",") != tc.op+",deliveries/held/ack" {
				t.Fatalf("%s posted %v", tc.tool, calls)
			}
		})
	}
}

// The live shape of the conference stall: the receiver pushes an invite, the
// model joins instead of replying, and every later message waits behind it.
// The loop must stay serialized while the delivery is held and pick up the
// next one on its own once the model moves on -- no prompt in between.
func TestReceiverDeliversNextMessageOnceHeldDeliveryIsReleased(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var claims, delivered atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		out := map[string]any{}
		switch path.Base(req.URL.Path) {
		case "native":
			out["native_session_id"] = "native"
		case "register":
			out["sources"] = []string{"peer"}
		case "claim":
			// Only the first two claims carry a message; the rest find the queue empty.
			if n := claims.Add(1); n <= 2 {
				out["delivery"] = map[string]any{"message_id": fmt.Sprintf("m%d", n), "content": "invite"}
			}
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	defer server.Close()
	c := &sessionClient{id: "session", http: &http.Client{Transport: rewriteTransport{server: server}}}
	tracker := newChannelTracker(c)
	r := &autoReceiver{client: c, tracker: tracker}
	tracker.receiver = r
	r.output = &mcpWriter{w: receiverHealthWriter{r: r, deliveries: &delivered}}
	done := make(chan error, 1)
	go func() { done <- r.connection(ctx) }()

	waitFor := func(what string, cond func() bool) {
		t.Helper()
		for !cond() {
			if ctx.Err() != nil {
				t.Fatalf("timed out waiting for %s (claims %d, delivered %d)", what, claims.Load(), delivered.Load())
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	waitFor("first delivery", func() bool { return delivered.Load() == 1 })
	time.Sleep(2500 * time.Millisecond)
	if claims.Load() != 1 || delivered.Load() != 1 {
		t.Fatalf("receiver claimed past a held delivery (claims %d, delivered %d)", claims.Load(), delivered.Load())
	}
	if _, err := callMCPTool(ctx, c, tracker, "agent_conf_join", map[string]any{"conference_id": "room"}); err != nil {
		t.Fatal(err)
	}
	waitFor("second delivery", func() bool { return delivered.Load() == 2 })
	cancel()
	<-done
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

func TestPortalReplySummaryKeepsCorrelationAndSupportsOlderCallers(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		for _, summary := range []string{"", "DNS fixed; approval needed."} {
			t.Run(engine+"/"+summary, func(t *testing.T) {
				t.Setenv("CXX_AGENT_PORTAL_ENGINE", engine)
				var event map[string]any
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					if strings.HasSuffix(req.URL.Path, "/events") {
						_ = json.NewDecoder(req.Body).Decode(&event)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{})
				}))
				defer server.Close()
				r := &autoReceiver{client: &sessionClient{id: "session", http: &http.Client{Transport: rewriteTransport{server: server}}}, pendingPortal: map[string]any{"message_id": "owned"}}
				args := map[string]any{"message_id": "owned", "content": "Full answer."}
				if summary != "" {
					args["summary"] = summary
				}
				if _, err := r.reply(context.Background(), args); err != nil {
					t.Fatal(err)
				}
				payload := event["payload"].(map[string]any)
				if payload["message_id"] != "owned" || payload["text"] != "Full answer." || event["client_event_id"] != "receiver:owned" {
					t.Fatalf("event: %v", event)
				}
				if summary == "" {
					if _, exists := payload["summary"]; exists {
						t.Fatal("missing summary must stay missing")
					}
				} else if payload["summary"] != summary {
					t.Fatalf("summary: %v", payload)
				}
				if r.pendingPortal != nil {
					t.Fatal("reply did not release portal delivery")
				}
			})
		}
	}
}

func TestChannelDeliveryPreservesFullContentAndMessageID(t *testing.T) {
	t.Setenv("CXX_AGENT_PORTAL_ENGINE", "claude")
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
	for _, engine := range []string{"codex", "claude", "grok"} {
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
				if engine == "grok" {
					socket := filepath.Join(t.TempDir(), "grok.sock")
					listener, err := net.Listen("unix", socket)
					if err != nil {
						t.Fatal(err)
					}
					defer listener.Close()
					go func() {
						for {
							conn, err := listener.Accept()
							if err != nil {
								return
							}
							go func() {
								defer conn.Close()
								q := &grokQueue{conn: conn}
								if _, err := q.read(); err != nil {
									return
								}
								if q.write(map[string]any{"type": "registered", "ready": true}) != nil {
									return
								}
								for {
									frame, err := q.read()
									if err != nil {
										return
									}
									var req map[string]any
									if json.Unmarshal([]byte(stringArg(frame, "payload")), &req) != nil {
										return
									}
									if stringArg(req, "method") != "_x.ai/sessions/list" {
										nativeDeliveries.Add(1)
									}
									result := map[string]any{"sessions": []any{map[string]any{"sessionId": "native", "resident": true, "activity": "idle"}}}
									raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req["id"], "result": result})
									if q.write(map[string]any{"type": "acp", "payload": string(raw)}) != nil {
										return
									}
								}
							}()
						}
					}()
					t.Setenv("CXX_GROK_SOCKET", socket)
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
		ID     string `json:"id"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		return 0, err
	}
	if msg.Method == "ping" {
		response, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": map[string]any{}})
		w.r.acceptPong(response)
	} else {
		w.deliveries.Add(1)
	}
	return len(data), nil
}
