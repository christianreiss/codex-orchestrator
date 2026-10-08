package codex

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeentry"
)

func TestFindCLISkipsManagedNativeEntrypointAndStaleCache(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CDX_CODEX_BIN", "")
	vendorDir := filepath.Join(home, "vendor")
	if err := os.MkdirAll(vendorDir, 0700); err != nil {
		t.Fatal(err)
	}
	vendor := filepath.Join(vendorDir, "codex")
	if err := os.WriteFile(vendor, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := nativeentry.Install(nativeentry.Options{Home: home, WrapperPath: self, Engines: []string{"codex"}}); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(nativeentry.BinDir(home), "codex")
	// Do not invoke either script: resolution itself must be side-effect free.
	t.Setenv("PATH", nativeentry.BinDir(home)+string(os.PathListSeparator)+vendorDir)
	if err := cacheCodex(shim); err != nil {
		t.Fatal(err)
	}
	got, err := FindCLI()
	if err != nil || got != vendor {
		t.Fatalf("FindCLI = %q, %v; want vendor %q", got, err, vendor)
	}
	if got := cachedCodexBin(); got != vendor {
		t.Fatalf("cached %q; want vendor %q", got, vendor)
	}
	t.Setenv("CDX_CODEX_BIN", shim)
	if _, err := FindCLI(); err == nil {
		t.Fatal("explicit shim should fail instead of reentering wrapper")
	}
	t.Setenv("CDX_CODEX_BIN", self)
	if _, err := FindCLI(); err == nil {
		t.Fatal("explicit wrapper should fail instead of recursing")
	}
}
