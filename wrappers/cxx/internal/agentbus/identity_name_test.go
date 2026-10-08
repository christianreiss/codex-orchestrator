package agentbus

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type titleRecorder struct{ id, title string }

func (w *titleRecorder) setSessionName(id, title string) error { w.id, w.title = id, title; return nil }

func TestNativeNamingUsesConfirmedCurrentIdentityAndBareTaskTitle(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			home := t.TempDir()
			for _, key := range []string{"CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"} {
				t.Setenv(key, home)
			}
			var path, raw string
			switch engine {
			case "codex":
				path = filepath.Join(home, "session_index.jsonl")
				raw = `{"id":"native","thread_name":"(Tanja) Review"}` + "\n"
			case "claude":
				path = filepath.Join(home, "projects", "project", "native.jsonl")
				raw = `{"type":"custom-title","sessionId":"native","customTitle":"(Tanja) Review"}` + "\n"
			case "grok":
				path = filepath.Join(home, "sessions", "project", "native", "summary.json")
				raw = `{"info":{"id":"native"},"title":"(Tanja) Review"}`
			}
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
				t.Fatal(err)
			}
			valid := true
			events := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/self") {
					id := "native"
					if !valid {
						id = "foreign"
					}
					_ = json.NewEncoder(w).Encode(ownIdentity{Name: "Claudia", SessionID: "launch", NativeID: id, Engine: engine, PreviousNames: []string{"Tanja"}})
					return
				}
				var body struct {
					Payload struct{ Name, NativeID string } `json:"payload"`
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body.Payload.Name != "Review" {
					t.Errorf("task title contains launch prefix: %s", body.Payload.Name)
				}
				events++
				_, _ = w.Write([]byte(`{}`))
			}))
			defer server.Close()
			client := &sessionClient{id: "launch", http: &http.Client{Transport: rewriteTransport{server}}}
			reporter := &sessionNameReporter{}
			writer := &titleRecorder{}
			valid = false
			reporter.report(context.Background(), client, engine, "native", writer)
			if writer.title != "" || events != 0 {
				t.Fatal("stale self response renamed a session")
			}
			valid = true
			reporter.report(context.Background(), client, engine, "native", writer)
			if writer.id != "native" || writer.title != "(Claudia) Review" || events != 1 {
				t.Fatalf("identity/title not synchronized: %+v events=%d", writer, events)
			}
		})
	}
}

func TestClaudeTitleMetadataPreservesTranscriptAndRejectsIncompleteTail(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", home)
	path := filepath.Join(home, "projects", "project", "native.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	original := []byte("{\"type\":\"user\",\"sessionId\":\"native\",\"message\":\"Keep transcript\"}\n")
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	writer := claudeSessionTitleWriter{}
	if err := writer.setSessionName("native", "(Claudia) Review"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || !strings.HasPrefix(string(raw), string(original)) {
		t.Fatal("conversation rewritten")
	}
	if got := nativeSessionName(home, "claude", "native"); got != "(Claudia) Review" {
		t.Fatalf("saved title=%q", got)
	}
	if err := writer.setSessionName("../other", "Wrong"); err == nil {
		t.Fatal("unsafe native ID accepted")
	}
	if err := writer.setSessionName("missing", "Wrong"); err == nil {
		t.Fatal("created an unbound transcript")
	}
	if err := os.WriteFile(path, []byte(`{"type":"user"`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writer.setSessionName("native", "Wrong"); err == nil {
		t.Fatal("appended into partial record")
	}
}

func TestAgentSelfMCPReadsCurrentServerIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/host/agent-sessions/launch/agent-messaging/self" {
			t.Errorf("unexpected identity route %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"identity_version": 1, "name": "Paula", "uuid": "server-current-uuid", "session_id": "launch", "native_session_id": "current-native"})
	}))
	defer server.Close()
	client := &sessionClient{id: "launch", http: &http.Client{Transport: rewriteTransport{server}}}
	params, _ := json.Marshal(map[string]any{"name": "agent_self", "arguments": map[string]any{}})
	response := handleMCPRequest(context.Background(), client, mcpRequest{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: "tools/call", Params: params}, false, newChannelTracker(client))
	raw, _ := json.Marshal(response)
	if !strings.Contains(string(raw), "Paula") || !strings.Contains(string(raw), "server-current-uuid") {
		t.Fatalf("self did not read current server identity: %s", raw)
	}
}
