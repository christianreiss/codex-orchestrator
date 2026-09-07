package lifecycle

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestHiddenBootSkipsNativeVersionProbe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is POSIX-only")
	}
	for _, hidden := range []bool{true, false} {
		name := "visible"
		if hidden {
			name = "hidden"
		}
		t.Run(name, func(t *testing.T) {
			cfg, home := syncOnlyHost(t, "")
			probes := filepath.Join(home, "version-probes")
			bin := filepath.Join(home, "codex-fixture")
			script := "#!/bin/sh\nprintf 'probe\\n' >> \"$CXX_TEST_VERSION_PROBES\"\nsleep 0.04\nprintf '2.1.200\\n'\n"
			if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
				t.Fatal(err)
			}
			t.Setenv("CDX_CODEX_BIN", bin)
			t.Setenv("CXX_TEST_VERSION_PROBES", probes)
			started := time.Now()
			exit, err := Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: true, SkipBoot: hidden, Minimal: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
			t.Logf("startup=%s hidden_boot=%t", time.Since(started), hidden)
			if exit != 0 || err != nil {
				t.Fatalf("Run() = %d, %v", exit, err)
			}
			_, statErr := os.Stat(probes)
			if hidden && !os.IsNotExist(statErr) {
				t.Fatalf("hidden boot executed the native version probe: %v", statErr)
			}
			if !hidden && statErr != nil {
				t.Fatalf("visible boot skipped the installed version probe: %v", statErr)
			}
		})
	}
}
