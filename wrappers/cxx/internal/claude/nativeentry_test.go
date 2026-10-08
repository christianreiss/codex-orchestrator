package claude

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestFindCLISkipsManagedNativeEntryAndStaleCache(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLX_CLAUDE_BIN", "")
	shimDir := filepath.Join(home, "shim")
	vendorDir := filepath.Join(home, "vendor")
	for _, dir := range []string{shimDir, vendorDir} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	shim := filepath.Join(shimDir, "claude")
	vendor := filepath.Join(vendorDir, "claude")
	if err := os.WriteFile(shim, []byte("#!/bin/sh\n# cxx:managed-native-entry:v1\nexit 99\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(vendor, []byte("#!/bin/sh\necho 2.1.168\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := cacheClaude(shim); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", shimDir+string(os.PathListSeparator)+vendorDir)
	got, err := FindCLI()
	if err != nil || got != vendor {
		t.Fatalf("FindCLI=%q err=%v want %q", got, err, vendor)
	}
	if cacheClaudeIfMatches(context.Background(), shim, "") {
		t.Fatal("installer accepted managed shim")
	}
	t.Setenv("CLX_CLAUDE_BIN", shim)
	if _, err := FindCLI(); err == nil {
		t.Fatal("explicit managed shim accepted")
	}
}
