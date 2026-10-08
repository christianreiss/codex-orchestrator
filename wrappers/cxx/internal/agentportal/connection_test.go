package agentportal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestConnectionRuntimeOwnsCapabilityAndFinishesOnce(t *testing.T) {
	t.Setenv(envSocket, "outer-socket")
	t.Setenv(envBridgeToken, "outer-token")
	var finishes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if r.URL.Path == "/host/agent-sessions" {
			json.NewEncoder(w).Encode(map[string]any{"enabled": true, "session_id": body["session_id"], "bridge_token": body["bridge_token"]})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/finish") {
			finishes.Add(1)
		}
		w.Write([]byte(`{}`))
	}))
	defer server.Close()
	cfg := &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "host-key"}, AgentMessaging: config.AgentMessaging{Enabled: true}}
	runtime, err := StartConnection(context.Background(), cfg, StartInput{Engine: "codex", InvocationKind: "interactive"})
	if err != nil {
		t.Fatal(err)
	}
	socket := os.Getenv(envSocket)
	if socket == "outer-socket" || socket == "" || os.Getenv(envBridgeToken) != "" {
		t.Fatal("private capability/environment not isolated")
	}
	if len(runtime.CodexMCPOverrides(false)) == 0 || runtime.Session() == nil || runtime.Context() == nil {
		t.Fatal("runtime unavailable")
	}
	if err := runtime.Close("completed", "done"); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Close("failed", "ignored"); err != nil {
		t.Fatal(err)
	}
	if finishes.Load() != 1 {
		t.Fatalf("finish count %d", finishes.Load())
	}
	if _, err := os.Stat(socket); !os.IsNotExist(err) {
		t.Fatalf("socket retained %v", err)
	}
	if os.Getenv(envSocket) != "outer-socket" || os.Getenv(envBridgeToken) != "outer-token" {
		t.Fatal("outer environment not restored")
	}
}

func TestDisabledConnectionRestoresEnvironment(t *testing.T) {
	t.Setenv(envSocket, "outer")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"enabled":false}`)) }))
	defer server.Close()
	runtime, err := StartConnection(context.Background(), &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL}}, StartInput{Engine: "claude"})
	if err != nil || runtime == nil || runtime.Session() != nil || os.Getenv(envSocket) != "" {
		t.Fatalf("disabled runtime=%v err=%v", runtime, err)
	}
	runtime.Close("completed", "disabled")
	if os.Getenv(envSocket) != "outer" {
		t.Fatal("outer environment not restored")
	}
}

func TestFailedConnectionKeepsInheritedCapabilityScrubbed(t *testing.T) {
	t.Setenv(envSocket, "outer-socket")
	t.Setenv(envBridgeToken, "outer-token")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"error":"forbidden"}`))
	}))
	defer server.Close()
	runtime, err := StartConnection(context.Background(), &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL}}, StartInput{Engine: "grok"})
	if err == nil || runtime == nil || runtime.Session() != nil {
		t.Fatalf("failed registration runtime=%v err=%v", runtime, err)
	}
	if os.Getenv(envSocket) != "" || os.Getenv(envBridgeToken) != "" {
		t.Fatal("failed startup restored capability before child exit")
	}
	if err := runtime.Close("failed", "unavailable"); err != nil {
		t.Fatal(err)
	}
	if os.Getenv(envSocket) != "outer-socket" || os.Getenv(envBridgeToken) != "outer-token" {
		t.Fatal("close did not restore inherited environment")
	}
}

func TestPendingConnectionRecoversWithoutChangingCapability(t *testing.T) {
	t.Setenv(envSocket, "outer")
	var available atomic.Bool
	var identity atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if r.URL.Path == "/host/agent-sessions" {
			key := body["session_id"].(string) + ":" + body["bridge_token"].(string)
			if prior := identity.Load(); prior != nil && prior.(string) != key {
				t.Error("recovery changed session identity")
			}
			identity.Store(key)
			if !available.Load() {
				w.WriteHeader(http.StatusServiceUnavailable)
				w.Write([]byte(`{}`))
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"enabled": true, "session_id": body["session_id"], "bridge_token": body["bridge_token"]})
			return
		}
		w.Write([]byte(`{}`))
	}))
	defer server.Close()
	runtime, err := StartConnection(context.Background(), &config.Config{Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "host-key"}, AgentMessaging: config.AgentMessaging{Enabled: true}}, StartInput{Engine: "codex"})
	if err == nil || runtime == nil || runtime.Session() == nil || runtime.Broker() == nil {
		t.Fatalf("pending connection runtime=%v err=%v", runtime, err)
	}
	socket := os.Getenv(envSocket)
	if socket == "" || socket == "outer" {
		t.Fatal("pending connection inherited outer capability")
	}
	available.Store(true)
	if err := runtime.Session().Heartbeat(context.Background(), "", ""); err != nil {
		t.Fatal(err)
	}
	if os.Getenv(envSocket) != socket {
		t.Fatal("recovery replaced local capability")
	}
	if err := runtime.Close("completed", "recovered"); err != nil {
		t.Fatal(err)
	}
	if os.Getenv(envSocket) != "outer" {
		t.Fatal("close did not restore outer capability")
	}
}
