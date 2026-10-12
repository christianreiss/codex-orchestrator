package grok

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestOldNativeLaunchStopsBeforeConfigSyncOrAccountLease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	t.Setenv("GROK_HOME", dir)
	cli := filepath.Join(dir, "grok")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf 'grok 1.0.46\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CGX_GROK_BIN", cli)
	settings := filepath.Join(dir, "config.toml")
	const original = "[ui]\npermission_mode = 'default'\n"
	if err := os.WriteFile(settings, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	// A nil client makes any accidental config sync/account request fail loudly.
	code, err := run(context.Background(), &config.Config{}, nil, options{}, io.Discard, io.Discard)
	if code != 1 || err == nil || !strings.Contains(err.Error(), "1.0.50") || !strings.Contains(err.Error(), "cgx update") {
		t.Fatalf("old native launch: code=%d error=%v", code, err)
	}
	if data, err := os.ReadFile(settings); err != nil || string(data) != original {
		t.Fatalf("settings changed before refusal: %q, %v", data, err)
	}
}

func TestNativeLaunchVersionProbeAcceptsCurrentAndRejectsPrereleaseOrUnknown(t *testing.T) {
	for _, fixture := range []struct {
		version string
		allowed bool
	}{{"1.0.50", true}, {"1.0.51", true}, {"1.0.50-rc.1", false}, {"unknown", false}} {
		t.Run(fixture.version, func(t *testing.T) {
			cli := filepath.Join(t.TempDir(), "grok")
			if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf 'grok "+fixture.version+"\\n'\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			err := requireSupportedNativeVersion(context.Background(), cli)
			if (err == nil) != fixture.allowed {
				t.Fatalf("version %s: %v", fixture.version, err)
			}
		})
	}
}
