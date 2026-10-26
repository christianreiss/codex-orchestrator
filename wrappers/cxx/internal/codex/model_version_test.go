package codex

import (
	"context"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUnsupportedTerraStopsBeforeAuthAndNativeExecution(t *testing.T) {
	home := t.TempDir()
	bin := filepath.Join(t.TempDir(), "codex")
	marker := filepath.Join(home, "launched")
	t.Setenv("CODEX_HOME", home)
	t.Setenv("CDX_CODEX_BIN", bin)
	if err := os.WriteFile(bin, []byte("#!/bin/sh\ncase \"$1\" in -V|--version) echo 'codex-cli 0.158.9';; *) touch '"+marker+"';; esac\n"), 0755); err != nil {
		t.Fatal(err)
	}
	original := []byte("model='gpt-6.1-terra'\n")
	if err := os.WriteFile(filepath.Join(home, "config.toml"), original, 0600); err != nil {
		t.Fatal(err)
	}
	auth := []byte(`{"test":"preserved"}`)
	if err := os.WriteFile(filepath.Join(home, "auth.json"), auth, 0600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Engine: "codex", Host: config.Host{Secure: true}}
	code, _, err := RunCapturePrepared(context.Background(), cfg, []string{"exec", "prompt"})
	if code != 2 || err == nil || !strings.Contains(err.Error(), "0.159.0") {
		t.Fatalf("%d %v", code, err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("native conversation started")
	}
	raw, _ := os.ReadFile(filepath.Join(home, "auth.json"))
	if string(raw) != string(auth) {
		t.Fatal("auth changed")
	}
	raw, _ = os.ReadFile(filepath.Join(home, "config.toml"))
	if string(raw) != string(original) {
		t.Fatal("config changed")
	}
	for _, args := range [][]string{{"--help"}, {"features", "list"}, {"login", "status"}} {
		if err := CheckModelSupport(context.Background(), cfg, args); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho 'codex-cli 0.159.0'\n"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := CheckModelSupport(context.Background(), cfg, []string{"exec", "prompt"}); err != nil {
		t.Fatal(err)
	}
}
