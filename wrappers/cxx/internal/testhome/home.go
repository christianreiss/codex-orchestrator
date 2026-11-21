// Package testhome isolates test fixtures that reach managed user state as
// well as their explicit native home. Only test files import it.
package testhome

import (
	"os"
	"path/filepath"
	"testing"
)

func Isolate(t testing.TB) {
	t.Helper()
	// A test name in the runtime directory can exceed the Unix socket limit.
	dir, err := os.MkdirTemp("", "cxx-test.")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	run := filepath.Join(dir, "run")
	if err := os.Mkdir(run, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", dir)
	t.Setenv("XDG_RUNTIME_DIR", run)
	for _, key := range []string{
		"XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME",
		"CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "KIMI_CODE_HOME",
		"CXX_GROK_BASE_HOME", "CXX_KIMI_BASE_HOME",
	} {
		t.Setenv(key, "")
	}
}
