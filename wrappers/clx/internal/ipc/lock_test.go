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
