package grok

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/skillstore"
)

func TestUninstallCancellationPreservesLocalState(t *testing.T) {
	home := t.TempDir()
	nativeHome := filepath.Join(home, ".grok")
	t.Setenv("HOME", home)
	t.Setenv("GROK_HOME", nativeHome)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("PATH", t.TempDir())
	store, err := native.Skills()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply([]skillstore.Item{{Slug: "keep", SHA256: sha("retained"), Content: "retained"}}); err != nil {
		t.Fatal(err)
	}
	storeDir, err := native.StoreDir()
	if err != nil {
		t.Fatal(err)
	}
	install := filepath.Join(storeDir, "keep")
	if err := os.MkdirAll(storeDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(install, []byte("retained"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/host/users" {
			_, _ = w.Write([]byte(`{"users":[]}`))
			return
		}
		if r.Method != http.MethodDelete || r.URL.Path != "/auth" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		cancel()
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	if err := uninstall(ctx, &config.Config{}, client, io.Discard, io.Discard); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled uninstall error = %v", err)
	}
	for _, target := range []string{install, filepath.Join(nativeHome, "skills", "keep", "SKILL.md")} {
		body, err := os.ReadFile(target)
		if err != nil || string(body) != "retained" {
			t.Errorf("cancelled uninstall changed %s: %q (%v)", target, body, err)
		}
	}
}
