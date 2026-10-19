package agentbus

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestNativeSessionNamesUseBoundMetadataAcrossEngines(t *testing.T) {
	home := t.TempDir()
	for _, env := range []string{"CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"} {
		t.Setenv(env, "")
	}
	write := func(path, text string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(home, ".codex/session_index.jsonl"), "{\"id\":\"native\",\"thread_name\":\"Old\"}\n{\"id\":\"other\",\"thread_name\":\"Wrong\"}\n{\"id\":\"native\",\"thread_name\":\"Release review\"}\n")
	write(filepath.Join(home, ".claude/projects/project/native.jsonl"), "{\"type\":\"custom-title\",\"sessionId\":\"native\",\"customTitle\":\"Schema review\"}\n{\"type\":\"custom-title\",\"sessionId\":\"other\",\"customTitle\":\"Wrong\"}\n")
	write(filepath.Join(home, ".grok/sessions/project/native/summary.json"), `{"info":{"id":"native"},"generated_title":"Policy review","session_summary":"Full transcript must never become a name"}`)
	for engine, want := range map[string]string{"codex": "Release review", "claude": "Schema review", "grok": "Policy review"} {
		if got := nativeSessionName(home, engine, "native"); got != want {
			t.Fatalf("%s name = %q, want %q", engine, got, want)
		}
		if got := nativeSessionName(home, engine, "../native"); got != "" {
			t.Fatalf("unsafe identity accepted: %q", got)
		}
		if got := nativeSessionName(home, engine, "missing"); got != "" {
			t.Fatalf("missing identity guessed: %q", got)
		}
	}
}

func TestSessionNameReportRetriesOriginalEventAndAllowsRenameBack(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	write := func(name string) {
		raw, _ := json.Marshal(map[string]string{"id": "native", "thread_name": name})
		if err := os.WriteFile(filepath.Join(home, "session_index.jsonl"), append(raw, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(req.Body).Decode(&body)
		bodies = append(bodies, body)
		if len(bodies) == 1 {
			w.WriteHeader(503)
		} else {
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer server.Close()
	client := &sessionClient{id: "wrapper", http: &http.Client{Transport: rewriteTransport{server}}}
	r := &sessionNameReporter{}
	write("First")
	r.report(context.Background(), client, "codex", "native")
	write("Second")
	r.report(context.Background(), client, "codex", "native")
	if bodies[0]["client_event_id"] != bodies[1]["client_event_id"] || bodies[1]["payload"].(map[string]any)["name"] != "First" {
		t.Fatal("ambiguous name retry changed its ID or payload")
	}
	r.report(context.Background(), client, "codex", "native")
	r.report(context.Background(), client, "codex", "native")
	if len(bodies) != 3 {
		t.Fatal("unchanged name emitted another event")
	}
	write("First")
	r.report(context.Background(), client, "codex", "native")
	if len(bodies) != 4 || bodies[3]["client_event_id"] == bodies[0]["client_event_id"] {
		t.Fatal("rename back reused an older event")
	}
}

type recordingTitleWriter struct{ names []string }

func (w *recordingTitleWriter) setSessionName(_ string, name string) error {
	w.names = append(w.names, name)
	return nil
}

func TestSessionTitleCarriesTheActiveRoleLabel(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	write := func(name string) {
		raw, _ := json.Marshal(map[string]string{"id": "native", "thread_name": name})
		if err := os.WriteFile(filepath.Join(home, "session_index.jsonl"), append(raw, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
	self := `{"name":"Sinja","session_id":"wrapper","native_session_id":"native","engine":"codex","role":{"label":"Designer"},"role_labels":["Designer"]}`
	var posted []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if filepath.Base(req.URL.Path) == "self" {
			_, _ = w.Write([]byte(self))
			return
		}
		var body struct {
			Payload struct {
				Name string `json:"name"`
			} `json:"payload"`
		}
		_ = json.NewDecoder(req.Body).Decode(&body)
		posted = append(posted, body.Payload.Name)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	client := &sessionClient{id: "wrapper", http: &http.Client{Transport: rewriteTransport{server}}}
	writer := &recordingTitleWriter{}
	r := &sessionNameReporter{}

	write("(Sinja) Rollensystem planen")
	r.report(context.Background(), client, "codex", "native", writer)
	if len(writer.names) != 1 || writer.names[0] != "(Sinja) (Designer) Rollensystem planen" {
		t.Fatalf("native title = %v", writer.names)
	}
	if len(posted) != 1 || posted[0] != "(Designer) Rollensystem planen" {
		t.Fatalf("server title = %v", posted)
	}

	// The writer's own result is stable: no second rename, no second event.
	write("(Sinja) (Designer) Rollensystem planen")
	r.report(context.Background(), client, "codex", "native", writer)
	if len(writer.names) != 1 || len(posted) != 1 {
		t.Fatalf("stable title rewritten: %v %v", writer.names, posted)
	}

	// Released: the old label comes off both titles.
	self = `{"name":"Sinja","session_id":"wrapper","native_session_id":"native","engine":"codex","role":null,"role_labels":["Designer"]}`
	r.report(context.Background(), client, "codex", "native", writer)
	if writer.names[len(writer.names)-1] != "(Sinja) Rollensystem planen" || posted[len(posted)-1] != "Rollensystem planen" {
		t.Fatalf("label not removed: %v %v", writer.names, posted)
	}
}
