package kimi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/memoryrouting"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

// With memory routing on, Kimi's reminder shares AGENTS.md with the fleet
// instructions. A sync that serves unchanged instructions must leave the file
// alone and report no update, instead of rewriting the body and letting memory
// routing put the reminder back.
func TestSyncWithMemoryRoutingLeavesUnchangedAgentsAlone(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	home := filepath.Join(t.TempDir(), "native")
	t.Setenv("KIMI_CODE_HOME", home)
	agents := "# Fleet instructions\nRead skills through MCP.\n"
	const reminder = "Use shared_memory_search over MCP"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/sync/bootstrap":
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "data": map[string]any{
				"status":         "ok",
				"agents":         map[string]any{"status": "updated", "version_id": 3, "content": agents},
				"memory_routing": map[string]any{"enabled": true, "content": reminder},
			}})
		case "/skills", "/host/users":
			_, _ = w.Write([]byte(`{"status":"ok","data":{}}`))
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	cfg := &config.Config{Engine: config.EngineKimi}
	cfg.Host.EnginesList = []string{config.EngineKimi}
	path := filepath.Join(home, "AGENTS.md")

	first, err := syncMeasuredManaged(context.Background(), cfg, client)
	if err != nil {
		t.Fatalf("first sync: %v", err)
	}
	if !first.Config.Updated {
		t.Fatal("first sync wrote AGENTS.md but reported no update")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(raw), memoryrouting.Start+"\n"+reminder+"\n") || !strings.HasSuffix(string(raw), agents) {
		t.Fatalf("AGENTS.md after first sync = %q", raw)
	}
	// Back-date the file so any rewrite during the second sync is visible.
	past := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(path, past, past); err != nil {
		t.Fatal(err)
	}

	second, err := syncMeasuredManaged(context.Background(), cfg, client)
	if err != nil {
		t.Fatalf("second sync: %v", err)
	}
	if second.Config.Updated {
		t.Fatal("second sync with unchanged instructions reported AGENTS.md as updated")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().Equal(past) {
		t.Fatalf("second sync rewrote AGENTS.md (mtime %v, want %v)", info.ModTime(), past)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != string(raw) {
		t.Fatalf("AGENTS.md changed: %q err=%v", after, err)
	}

	// Changed instructions are written once, beneath the existing reminder.
	agents = "# Fleet instructions\nRevised.\n"
	third, err := syncMeasuredManaged(context.Background(), cfg, client)
	if err != nil {
		t.Fatalf("third sync: %v", err)
	}
	if !third.Config.Updated {
		t.Fatal("changed instructions were not reported as updated")
	}
	revised, err := os.ReadFile(path)
	want := strings.TrimSuffix(string(raw), "# Fleet instructions\nRead skills through MCP.\n") + agents
	if err != nil || string(revised) != want {
		t.Fatalf("AGENTS.md after changed instructions = %q, want %q (err=%v)", revised, want, err)
	}
}
