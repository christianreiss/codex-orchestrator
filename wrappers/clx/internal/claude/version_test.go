package claude

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
	bin := filepath.Join(dir, "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho '2.1.186 (Claude Code)'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)

	if got := Version(context.Background()); got != "2.1.186" {
		t.Fatalf("Version() = %q, want 2.1.186", got)
	}
}

func TestVersionUnknownWhenCLIAbsent(t *testing.T) {
	// Point the override at a path that does not exist: FindCLI fails, Version
	// degrades to "unknown" rather than panicking or hanging.
	t.Setenv("CLX_CLAUDE_BIN", filepath.Join(t.TempDir(), "nope"))
	t.Setenv("PATH", t.TempDir())
	if got := Version(context.Background()); got != "unknown" {
		t.Fatalf("Version() = %q, want unknown", got)
	}
}
