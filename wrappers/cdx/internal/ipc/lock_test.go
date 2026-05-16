package ipc

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestAcquireReleaseRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", dir)
	l, err := Acquire("cdx-test")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "cdx-test.lock")); statErr != nil {
		t.Fatalf("lock file missing: %v", statErr)
	}
	if err := l.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
}

func TestAcquireBlocksWhenHeld(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", dir)
	first, err := Acquire("cdx-test")
	if err != nil {
		t.Fatalf("acquire #1: %v", err)
	}
	defer first.Release()
	_, err = Acquire("cdx-test")
	if !errors.Is(err, ErrHeld) {
		t.Fatalf("expected ErrHeld, got %v", err)
	}
}
