package agentportal

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// recordedCall is one request the CLI made through the broker socket.
type recordedCall struct {
	Path string
	Body map[string]any
}

// portalStub stands in for the in-wrapper broker. The portal subcommands only
// ever speak to a 0600 unix socket, so exercising them end to end means serving
// one rather than reaching into the client.
type portalStub struct {
	mu      sync.Mutex
	calls   []recordedCall
	claim   map[string]any
	claimed bool
}

func (s *portalStub) record(path string, body map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, recordedCall{Path: path, Body: body})
}

func (s *portalStub) callsTo(path string) []recordedCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []recordedCall
	for _, call := range s.calls {
		if call.Path == path {
			out = append(out, call)
		}
	}
	return out
}

func startPortalStub(t *testing.T, stub *portalStub) string {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "portal.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	if err := os.Chmod(socket, 0o600); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body := map[string]any{}
		_ = json.Unmarshal(raw, &body)
		stub.record(r.URL.Path, body)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case hasSuffix(r.URL.Path, "/commands/claim"):
			if stub.claim != nil && !stub.claimed {
				stub.claimed = true
				_ = json.NewEncoder(w).Encode(stub.claim)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"enabled": true})
		}
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	return socket
}

func hasSuffix(value, suffix string) bool {
	return len(value) >= len(suffix) && value[len(value)-len(suffix):] == suffix
}

const stubSessionID = "22222222-2222-4222-8222-222222222222"

func withPortalEnv(t *testing.T, socket string) {
	t.Helper()
	t.Setenv(envSocket, socket)
	t.Setenv(envSessionID, stubSessionID)
	t.Setenv(envEngine, "codex")
}

func heartbeats(stub *portalStub) []recordedCall {
	return stub.callsTo("/host/agent-sessions/" + stubSessionID + "/heartbeat")
}

// The relay window used to open on the strength of a notice alone, so the
// portal reported "listening" for a full window against an agent whose turn had
// already ended -- and accepted instructions nothing would ever claim.
func TestNotifyDoesNotOpenTheRelay(t *testing.T) {
	stub := &portalStub{}
	withPortalEnv(t, startPortalStub(t, stub))

	if code := runNotify([]string{"--summary", "needs a decision"}, io.Discard, io.Discard); code != 0 {
		t.Fatalf("runNotify exit = %d", code)
	}

	beats := heartbeats(stub)
	if len(beats) != 1 {
		t.Fatalf("expected exactly one heartbeat, got %d", len(beats))
	}
	if action, ok := beats[0].Body["relay_action"]; ok {
		t.Fatalf("notify sent relay_action=%v; only a live wait may open the relay", action)
	}
	if len(stub.callsTo("/host/agent-sessions/"+stubSessionID+"/events")) != 1 {
		t.Fatalf("expected the attention event to still be published")
	}
}

// The wait loop is the only thing that may claim the relay, and it must keep
// doing so on every iteration or a parked agent decays to "not listening".
func TestWaitOpensTheRelayAndClearsTheTurn(t *testing.T) {
	stub := &portalStub{}
	withPortalEnv(t, startPortalStub(t, stub))

	if code := runWait([]string{"--seconds", "0"}, io.Discard, io.Discard); code != 0 {
		t.Fatalf("runWait exit = %d", code)
	}

	beats := heartbeats(stub)
	if len(beats) == 0 {
		t.Fatal("wait sent no heartbeat")
	}
	first := beats[0].Body
	if first["relay_action"] != "poll" {
		t.Fatalf("relay_action = %v, want poll", first["relay_action"])
	}
	// Explicit null, not absent: absent means "keep what you had", which would
	// leave a finished turn reported as still running.
	turn, present := first["active_turn_id"]
	if !present || turn != nil {
		t.Fatalf("active_turn_id = %v (present=%v), want an explicit null", turn, present)
	}
}

// Nothing polls while the agent executes, so without this the portal has no
// way to tell "working on your instruction" from "stopped responding".
func TestAcceptClaimsTheTurn(t *testing.T) {
	stub := &portalStub{}
	withPortalEnv(t, startPortalStub(t, stub))

	const messageID = "33333333-3333-4333-8333-333333333333"
	code := runAccept([]string{"--message-id", messageID, "--lease-owner", "lease-1"}, io.Discard, io.Discard)
	if code != 0 {
		t.Fatalf("runAccept exit = %d", code)
	}

	beats := heartbeats(stub)
	if len(beats) != 1 {
		t.Fatalf("expected one heartbeat after accept, got %d", len(beats))
	}
	if beats[0].Body["active_turn_id"] != messageID {
		t.Fatalf("active_turn_id = %v, want %q", beats[0].Body["active_turn_id"], messageID)
	}
}

// `say` is the agent reporting back, which ends the turn whether or not it goes
// straight back to waiting.
func TestSayReleasesTheTurn(t *testing.T) {
	stub := &portalStub{}
	withPortalEnv(t, startPortalStub(t, stub))

	if code := runSay([]string{"--text", "done"}, io.Discard, io.Discard); code != 0 {
		t.Fatalf("runSay exit = %d", code)
	}

	beats := heartbeats(stub)
	if len(beats) != 1 {
		t.Fatalf("expected one heartbeat after say, got %d", len(beats))
	}
	turn, present := beats[0].Body["active_turn_id"]
	if !present || turn != nil {
		t.Fatalf("active_turn_id = %v (present=%v), want an explicit null", turn, present)
	}
}

func TestHeartbeatTurnOmitsTheFieldWhenNotManaged(t *testing.T) {
	stub := &portalStub{}
	withPortalEnv(t, startPortalStub(t, stub))

	session, err := SessionFromEnvironment(0)
	if err != nil {
		t.Fatalf("SessionFromEnvironment: %v", err)
	}
	if err := session.Heartbeat(t.Context(), "", ""); err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}

	beats := heartbeats(stub)
	if len(beats) != 1 {
		t.Fatalf("expected one heartbeat, got %d", len(beats))
	}
	// A plain liveness beat must not disturb the turn: the 15s ticker runs
	// throughout execution and would otherwise clear it every tick.
	if _, present := beats[0].Body["active_turn_id"]; present {
		t.Fatal("a plain heartbeat sent active_turn_id")
	}
}
