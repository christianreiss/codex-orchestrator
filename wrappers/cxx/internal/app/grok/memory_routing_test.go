package grok

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/memoryrouting"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

func TestGrokManagedSyncMemoryRoutingAndTrustLoss(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, ".grok")
	t.Setenv("HOME", root)
	t.Setenv("GROK_HOME", home)
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(root, "run"))
	bundle := &memoryrouting.Bundle{Enabled: true, Content: "shared_memory_read central reminder"}
	refused := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if refused {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"code":"invalid_api_key","message":"host invalid"}}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "memory_routing": bundle, "grok_skills": []any{}})
	}))
	defer server.Close()
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Engine: "grok"}
	path := filepath.Join(home, "memory", "MEMORY.md")
	for range 2 {
		if _, err := syncMeasuredManaged(context.Background(), cfg, client); err != nil {
			t.Fatal(err)
		}
	}
	body, err := os.ReadFile(path)
	if err != nil || strings.Count(string(body), memoryrouting.Start) != 1 {
		t.Fatalf("reminder %q %v", body, err)
	}
	// A transport outage preserves the last synced reminder.
	server.Close()
	if _, err := syncMeasuredManaged(context.Background(), cfg, client); err == nil {
		t.Fatal("offline sync claimed success")
	}
	current, _ := os.ReadFile(path)
	if string(current) != string(body) {
		t.Fatal("offline cleanup removed reminder")
	}
	// A new endpoint provides an explicit host trust-loss response.
	refused = true
	refusalServer := httptest.NewServer(server.Config.Handler)
	defer refusalServer.Close()
	client, err = orchestrator.New(orchestrator.Options{BaseURL: refusalServer.URL, APIKey: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := syncMeasuredManaged(context.Background(), cfg, client); err == nil {
		t.Fatal("trust loss accepted")
	}
	current, _ = os.ReadFile(path)
	if strings.Contains(string(current), memoryrouting.Start) {
		t.Fatal("trust loss did not remove reminder")
	}
}
