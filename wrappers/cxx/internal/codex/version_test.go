package codex

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestVersionExtractsSemverToken(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is POSIX-only")
	}

	dir := t.TempDir()
	bin := filepath.Join(dir, "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho codex-cli 0.130.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CDX_CODEX_BIN", bin)

	if got := Version(context.Background()); got != "0.130.0" {
		t.Fatalf("Version() = %q, want 0.130.0", got)
	}
}
