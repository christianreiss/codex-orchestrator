package claude

import (
	"os"
	"path/filepath"
	"testing"
)

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
