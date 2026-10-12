package cron

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
)

func TestUpdateRefreshConvergesChangedAssignments(t *testing.T) {
	for _, removeClaude := range []bool{false, true} {
		t.Run(map[bool]string{false: "add Grok", true: "replace Claude with Grok"}[removeClaude], func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
			for _, key := range []string{"CDX_CONFIG_PATH", "CLX_CONFIG_PATH", "CGX_CONFIG_PATH"} {
				t.Setenv(key, "")
			}
			dir := t.TempDir()
			cxx := filepath.Join(dir, "cxx")
			if err := os.WriteFile(cxx, []byte("common"), 0o755); err != nil {
				t.Fatal(err)
			}
			for _, engine := range []string{"codex", "claude"} {
				cfg := &config.Config{Engine: engine}
				if err := fleetconfig.Persist(context.Background(), &fleetconfig.Fetched{Config: cfg, Payload: []byte("old"), Signature: "old signature"}); err != nil {
					t.Fatal(err)
				}
				alias := map[string]string{"codex": "cdx", "claude": "clx"}[engine]
				if err := os.Symlink("cxx", filepath.Join(dir, alias)); err != nil {
					t.Fatal(err)
				}
			}
			host := config.Host{ID: 7, FQDN: "host.example.com", EnginesList: []string{"codex", "claude"}}
			seed := &config.Config{Engine: "codex", Host: host}
			host.EnginesList = []string{"codex", "claude", "grok"}
			if removeClaude {
				host.EnginesList = []string{"codex", "grok"}
			}
			oldFetch := fetchAuthoritative
			t.Cleanup(func() { fetchAuthoritative = oldFetch })
			var probes []string
			fetchAuthoritative = func(_ context.Context, _ *config.Config, engine string) (*fleetconfig.Fetched, error) {
				probes = append(probes, engine)
				if removeClaude && engine == "claude" {
					return nil, fleetconfig.ErrEngineDisabled
				}
				cfg := &config.Config{Engine: engine, Host: host}
				payload, err := json.Marshal(cfg)
				return &fleetconfig.Fetched{Config: cfg, Payload: payload, Signature: "verified upstream"}, err
			}
			configs, err := RefreshForUpdate(context.Background(), seed, cxx, io.Discard)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(probes, []string{"codex", "claude", "grok"}) || len(configs) != len(host.EnginesList) {
				t.Fatalf("probes=%v configs=%v", probes, configs)
			}
			for _, cfg := range configs {
				path, _ := config.DefaultPathForEngine(cfg.Engine)
				body, err := os.ReadFile(path)
				if err != nil || !strings.Contains(string(body), `"grok"`) {
					t.Fatalf("fresh %s config missing: %s %v", cfg.Engine, body, err)
				}
				if sig, err := os.ReadFile(path + ".sig"); err != nil || string(sig) != "verified upstream" {
					t.Fatalf("%s signature missing: %s %v", cfg.Engine, sig, err)
				}
				alias := map[string]string{"codex": "cdx", "claude": "clx", "grok": "cgx"}[cfg.Engine]
				if target, err := os.Readlink(filepath.Join(dir, alias)); err != nil || target != "cxx" {
					t.Fatalf("%s alias=%q: %v", alias, target, err)
				}
			}
			if removeClaude {
				path, _ := config.DefaultPathForEngine("claude")
				for _, removed := range []string{path, path + ".sig", filepath.Join(dir, "clx")} {
					if _, err := os.Lstat(removed); !os.IsNotExist(err) {
						t.Fatalf("disabled state remains: %s %v", removed, err)
					}
				}
			}
		})
	}
}

func TestUpdateRefreshReportsCleanupFailure(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	cxx := filepath.Join(dir, "cxx")
	if err := os.WriteFile(cxx, []byte("common"), 0o755); err != nil {
		t.Fatal(err)
	}
	seed := &config.Config{Engine: "codex", Host: config.Host{ID: 7, FQDN: "host.example.com"}}
	oldFetch, oldPersist, oldRemove := fetchAuthoritative, persistAuthoritative, removeEngineConfig
	t.Cleanup(func() { fetchAuthoritative, persistAuthoritative, removeEngineConfig = oldFetch, oldPersist, oldRemove })
	fetchAuthoritative = func(_ context.Context, _ *config.Config, engine string) (*fleetconfig.Fetched, error) {
		if engine == "claude" {
			return nil, fleetconfig.ErrEngineDisabled
		}
		return &fleetconfig.Fetched{Config: seed}, nil
	}
	persistAuthoritative = func(context.Context, *fleetconfig.Fetched) error { return nil }
	removeEngineConfig = func(context.Context, string) error { return errors.New("disk full") }
	if _, err := RefreshForUpdate(context.Background(), seed, cxx, io.Discard); err == nil || !strings.Contains(err.Error(), "remove disabled claude config: disk full") {
		t.Fatalf("cleanup failure was hidden: %v", err)
	}
}
