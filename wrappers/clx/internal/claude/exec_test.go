package claude

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
)

// RunCapture must refuse to launch Claude when the runtime hostname does not
// match the baked FQDN (the documented launch guard). Before the fix the
// PreExec error was swallowed and Claude launched against the wrong host
// identity. PreExec fails before claude is ever spawned, so this never execs.
func TestRunCaptureRefusesFQDNMismatch(t *testing.T) {
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "")
	// Make FindCLI succeed with a dummy so the test reaches PreExec regardless of
	// whether a real claude is installed; PreExec fails first so it is never run.
	dummy := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(dummy, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", dummy)
	cfg := &config.Config{}
	cfg.Host.FQDN = "totally-different-host.invalid.example.org"
	exit, _, err := RunCapture(context.Background(), cfg, []string{"--version"})
	if err == nil || exit == 0 {
		t.Fatalf("expected refusal, got exit=%d err=%v", exit, err)
	}
	if !strings.Contains(err.Error(), "FQDN") {
		t.Fatalf("expected FQDN mismatch error, got %v", err)
	}
}

func TestIsWrapperSelf(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Skipf("os.Executable unavailable: %v", err)
	}
	if !isWrapperSelf(self) {
		t.Fatalf("isWrapperSelf(self=%q) = false, want true", self)
	}

	// A symlink pointing at the running binary must resolve back to self so
	// FindCLI skips it (the `claude`-shadows-`clx` recursion guard).
	link := filepath.Join(t.TempDir(), "claude")
	if err := os.Symlink(self, link); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	if !isWrapperSelf(link) {
		t.Fatalf("isWrapperSelf(symlink->self) = false, want true")
	}

	// A genuinely different binary must not be flagged as self.
	for _, other := range []string{"/bin/sh", "/usr/bin/env", "/bin/true"} {
		if _, statErr := os.Stat(other); statErr == nil {
			if isWrapperSelf(other) {
				t.Fatalf("isWrapperSelf(%q) = true, want false", other)
			}
			break
		}
	}
}
