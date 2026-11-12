package kimi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestPrivateCatalogSurvivesCleanupWithoutOverwritingConcurrentProjects(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	base := t.TempDir()
	r, err := NewRuntime(base, &config.Config{}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Apply(accessEnvelope("ephemeral-access"), 0); err != nil {
		t.Fatal(err)
	}
	index := filepath.Join(r.Home, "session_index.jsonl")
	f, err := os.OpenFile(index, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.WriteString("{\"sessionId\":\"retained\"}\n")
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	// Model the native atomic catalog replacement and another session's completion.
	local := []byte(`{"schema_version":2,"projects":{"local":{"root":"/local","last_opened_at":"2026-11-12T10:00:00Z"}},"deleted_project_ids":[],"idempotency_keys":{}}`)
	other := []byte(`{"schema_version":2,"projects":{"peer":{"root":"/peer"}},"deleted_project_ids":[],"idempotency_keys":{},"user_extra":true}`)
	if err := AtomicWrite(filepath.Join(r.Home, "projects.json"), local, 0600); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWrite(filepath.Join(base, "projects.json"), other, 0600); err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(base, "projects.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if json.Unmarshal(raw, &got) != nil {
		t.Fatal(string(raw))
	}
	projects := got["projects"].(map[string]any)
	if len(projects) != 2 || got["user_extra"] != true {
		t.Fatal(string(raw))
	}
	raw, err = os.ReadFile(filepath.Join(base, "session_index.jsonl"))
	if err != nil || !strings.Contains(string(raw), "retained") {
		t.Fatal(string(raw), err)
	}
	if _, err := os.Stat(filepath.Join(base, "credentials")); !os.IsNotExist(err) {
		t.Fatal("private credentials persisted")
	}
	if _, err := os.Stat(r.Dir); !os.IsNotExist(err) {
		t.Fatal("private home retained", err)
	}
}
