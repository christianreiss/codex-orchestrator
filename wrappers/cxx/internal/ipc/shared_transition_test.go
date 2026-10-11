package ipc

import (
	"errors"
	"testing"
)

func TestContentSyncDowngradeKeepsEveryNativeConsumerProtected(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	first, err := TryAcquireExclusive("grok-content-transition")
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()
	if err := first.DowngradeToShared(); err != nil {
		t.Fatal(err)
	}
	second, err := AcquireShared("grok-content-transition")
	if err != nil {
		t.Fatal(err)
	}
	defer second.Release()
	_ = first.Release()
	if lock, err := TryAcquireExclusive("grok-content-transition"); !errors.Is(err, ErrHeld) {
		if lock != nil {
			_ = lock.Release()
		}
		t.Fatalf("second native consumer unprotected: %v", err)
	}
	_ = second.Release()
	lock, err := TryAcquireExclusive("grok-content-transition")
	if err != nil {
		t.Fatal(err)
	}
	_ = lock.Release()
}
