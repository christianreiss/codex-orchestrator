package ipc

import (
	"errors"
	"testing"
)

func TestAcquireBlocksWhenHeld(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	first, err := Acquire("clx-test")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer first.Release()
	if _, err := Acquire("clx-test"); !errors.Is(err, ErrHeld) {
		t.Fatalf("expected ErrHeld, got %v", err)
	}
}

func TestAcquireDoesNotShareCodexLock(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	cdx, err := Acquire("cdx-cross-test")
	if err != nil {
		t.Fatalf("acquire cdx lock: %v", err)
	}
	defer cdx.Release()

	clx, err := Acquire("clx-cross-test")
	if err != nil {
		t.Fatalf("clx lock should not be blocked by cdx lock: %v", err)
	}
	defer clx.Release()
}
