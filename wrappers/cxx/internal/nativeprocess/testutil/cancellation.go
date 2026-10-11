// Package testutil provides a cooperative native fixture for wrapper tests.
package testutil

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Cancellation verifies the actual wrapper launch path, including its leases,
// lets the native TERM handler finish, and observes conventional signal status.
func Cancellation(t *testing.T, run func(context.Context, string) (int, error)) {
	t.Helper()
	dir := t.TempDir()
	ready, handled := filepath.Join(dir, "ready"), filepath.Join(dir, "handled")
	t.Setenv("CXX_TEST_READY", ready)
	t.Setenv("CXX_TEST_HANDLED", handled)
	path := filepath.Join(dir, "native")
	script := "#!/bin/sh\ntrap 'echo caught > \"$CXX_TEST_HANDLED\"; exit 143' TERM\n: > \"$CXX_TEST_READY\"\nwhile :; do sleep 0.02; done\n"
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	type result struct {
		code int
		err  error
	}
	done := make(chan result, 1)
	go func() { code, err := run(ctx, path); done <- result{code, err} }()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("native fixture did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case result := <-done:
		if result.code != 143 || result.err != nil {
			t.Fatalf("wrapper returned %d, %v; want 143, nil", result.code, result.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cooperative native child was not reaped")
	}
	if _, err := os.Stat(handled); err != nil {
		t.Fatal("native TERM handler did not run:", err)
	}
}
