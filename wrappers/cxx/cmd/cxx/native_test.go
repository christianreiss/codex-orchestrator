package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeentry"
)

func TestNativeDispatchRejectsAmbiguousDescriptor(t *testing.T) {
	for _, args := range [][]string{nil, {"codex"}, {"codex", "--version"}, {"other", "--"}} {
		var out, errout bytes.Buffer
		if code := runNative(args, &out, &errout); code != 2 {
			t.Fatalf("args=%q code=%d stderr=%q", args, code, errout.String())
		}
	}
}

func TestNativeVersionDispatchesVendorForAllEngines(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
			t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
			t.Setenv("GROK_HOME", filepath.Join(home, ".grok"))
			cli := filepath.Join(home, "vendor-"+engine)
			if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			env := map[string]string{"codex": "CDX_CODEX_BIN", "claude": "CLX_CLAUDE_BIN", "grok": "CGX_GROK_BIN"}[engine]
			t.Setenv(env, cli)
			var out, errout bytes.Buffer
			if code := runNative([]string{engine, "--", "--version"}, &out, &errout); code != 0 || out.String() != "--version\n" {
				t.Fatalf("code=%d stdout=%q stderr=%q", code, out.String(), errout.String())
			}
		})
	}
}

func TestNativeDiagnosticAndBridgeCallsDoNotInstallEntries(t *testing.T) {
	for _, args := range [][]string{
		{"native", "codex", "--", "--version"}, {"native", "grok", "--", "-v"},
		{"native", "claude", "--", "mcp", "--help"}, {"agent", "mcp", "--auto"},
		{"native-entry", "remove"}, {"--version"}, {"uninstall"},
	} {
		if shouldReconcileNativeEntries(args) {
			t.Fatalf("diagnostic installed entries: %q", args)
		}
	}
	if !shouldReconcileNativeEntries([]string{"sync"}) {
		t.Fatal("sync did not prepare entries")
	}
}

// A successful privileged command run with another user's HOME skips native
// entries instead of failing; every other reconciliation error still fails.
func TestImplicitNativeEntryIgnoresOnlyForeignHome(t *testing.T) {
	if err := implicitNativeEntryError(fmt.Errorf("wrapped: %w", nativeentry.ErrForeignHome)); err != nil {
		t.Fatalf("foreign home failed the command: %v", err)
	}
	other := errors.New("refusing to overwrite unmanaged native entry")
	if err := implicitNativeEntryError(other); err != other {
		t.Fatalf("real error swallowed: %v", err)
	}
	if err := implicitNativeEntryError(nil); err != nil {
		t.Fatal(err)
	}
}
