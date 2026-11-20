//go:build !windows

package uninstall

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A hung `npm ls -g` (broken registry config, stuck prefix lock) must not hang
// clx --uninstall: the probe is bounded by probeTimeout exactly like cdx's.
func TestNpmGlobalHasGivesUpOnHungNpm(t *testing.T) {
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "npm"), []byte("#!/bin/sh\nexec sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+"/bin"+string(os.PathListSeparator)+"/usr/bin")
	done := make(chan bool, 1)
	start := time.Now()
	go func() { done <- npmGlobalHas(context.Background(), "@anthropic-ai/claude-code") }()
	select {
	case found := <-done:
		if found {
			t.Fatal("a timed-out probe reported the package as installed")
		}
		if elapsed := time.Since(start); elapsed < probeTimeout-time.Second {
			t.Fatalf("probe returned after %v, before the npm stub could have exited", elapsed)
		}
	case <-time.After(probeTimeout + 5*time.Second):
		t.Fatalf("npm probe still running after %v; probeTimeout (%v) was not applied", probeTimeout+5*time.Second, probeTimeout)
	}
}
