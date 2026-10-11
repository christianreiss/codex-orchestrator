package grok

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/skillstore"
)

func TestTrustLossStripsOwnedContentAndPreservesLocalEdits(t *testing.T) {
	for _, edited := range []bool{false, true} {
		t.Run(map[bool]string{false: "owned", true: "user-edited"}[edited], func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
			home := filepath.Join(t.TempDir(), "native")
			t.Setenv("GROK_HOME", home)
			store, err := native.Skills()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := store.Apply([]skillstore.Item{{Slug: "fleet", Content: "fleet-skill", SHA256: sha("fleet-skill")}}); err != nil {
				t.Fatal(err)
			}
			user := filepath.Join(home, "skills", "user")
			_ = os.MkdirAll(user, 0700)
			_ = os.WriteFile(filepath.Join(user, "SKILL.md"), []byte("user-skill"), 0600)
			_ = os.WriteFile(filepath.Join(home, "config.toml"), []byte("user_setting='keep'\n"), 0600)
			if err := native.SyncConfig(home, []byte("[mcp_servers.fleet]\nurl='https://fixture'\n"), []string{"mcp_servers.fleet"}); err != nil {
				t.Fatal(err)
			}
			state, _ := native.StateDir()
			_ = os.WriteFile(filepath.Join(home, "AGENTS.md"), []byte("fleet-agents"), 0600)
			_ = os.WriteFile(filepath.Join(state, "managed-agents.sha256"), []byte(sha("fleet-agents")), 0600)
			if edited {
				_ = os.WriteFile(filepath.Join(home, "AGENTS.md"), []byte("user-agents"), 0600)
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(401)
				_, _ = io.WriteString(w, `{"error":{"code":"invalid_api_key","message":"invalid"}}`)
			}))
			defer srv.Close()
			client := &orchestrator.Client{BaseURL: srv.URL, HTTP: srv.Client()}
			if _, err := syncMeasuredManaged(context.Background(), &config.Config{}, client); err == nil {
				t.Fatal("trust loss accepted")
			}
			if _, err := os.Stat(filepath.Join(home, "skills", "fleet")); !os.IsNotExist(err) {
				t.Fatal("owned skill survived")
			}
			if _, err := os.Stat(filepath.Join(user, "SKILL.md")); err != nil {
				t.Fatal("user skill removed")
			}
			raw, _ := os.ReadFile(filepath.Join(home, "config.toml"))
			if strings.Contains(string(raw), "fixture") || !strings.Contains(string(raw), "keep") {
				t.Fatalf("config cleanup %s", raw)
			}
			body, err := os.ReadFile(filepath.Join(home, "AGENTS.md"))
			if edited {
				if err != nil || string(body) != "user-agents" {
					t.Fatal("user instructions removed")
				}
			} else if !os.IsNotExist(err) {
				t.Fatal("fleet instructions survived")
			}
		})
	}
}

func TestContentLeaseWaitIsCanceledBehindExclusiveWriter(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	writer, err := ipc.TryAcquireExclusive("cgx-sync")
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Release()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		lease, err := acquireContentLease(ctx)
		if lease != nil {
			_ = lease.Release()
		}
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("held writer did not block reader: %v", err)
	case <-time.After(80 * time.Millisecond):
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("wait returned %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("content lease ignored cancellation")
	}
}
