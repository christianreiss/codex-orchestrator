//go:build !windows

package grok

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A native Grok that the wrapper stops and that then exits 0 (its graceful
// "Resume this session with" path) must not be reported as a start failure.
func TestExecuteReportsWhoStoppedARunningGrok(t *testing.T) {
	for _, tc := range []struct {
		name  string
		cause error
		want  string
	}{
		{"fatal auth", errGrokAuthEnded, "cgx: native Grok stopped: " + errGrokAuthEnded.Error()},
		{"plain cancel", nil, "cgx: native Grok stopped: the managed session ended"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			ready := filepath.Join(dir, "ready")
			path := filepath.Join(dir, "native")
			script := "#!/bin/sh\ntrap 'echo \"Resume this session with: grok --resume x\"; exit 0' TERM\n: > \"" + ready + "\"\nwhile :; do sleep 0.02; done\n"
			if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancelCause(context.Background())
			defer cancel(nil)
			var stderr bytes.Buffer
			done := make(chan int, 1)
			go func() { done <- execute(ctx, path, nil, os.Environ(), &bytes.Buffer{}, &stderr) }()
			waitForFile(t, ready)
			cancel(tc.cause)
			select {
			case code := <-done:
				if code != 1 {
					t.Fatalf("exit code %d, want 1", code)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("native fixture was not reaped")
			}
			got := stderr.String()
			if strings.Contains(got, "failed to start") || !strings.Contains(got, tc.want) {
				t.Fatalf("stderr %q, want %q", got, tc.want)
			}
		})
	}
}

func TestExecuteStillReportsStartFailure(t *testing.T) {
	var stderr bytes.Buffer
	code := execute(context.Background(), filepath.Join(t.TempDir(), "missing"), nil, os.Environ(), &bytes.Buffer{}, &stderr)
	if code != 1 || !strings.Contains(stderr.String(), "cgx: native Grok failed to start") {
		t.Fatalf("code %d stderr %q", code, stderr.String())
	}
}

func TestLeaderExitReport(t *testing.T) {
	exitErr := exec.Command("/bin/sh", "-c", "exit 3").Run()
	if exitErr == nil {
		t.Fatal("fixture exited 0")
	}
	live := context.Background()
	if line, failed := leaderExitReport(live, nil); line != "" || failed {
		t.Fatalf("clean exit reported %q %v", line, failed)
	}
	if line, failed := leaderExitReport(live, exitErr); !failed || !strings.Contains(line, "exited unexpectedly: exit status 3") {
		t.Fatalf("own failure reported %q %v", line, failed)
	}
	ended, cancel := context.WithCancelCause(live)
	cancel(errGrokAuthEnded)
	if line, failed := leaderExitReport(ended, exitErr); failed || !strings.Contains(line, "stopped with the session ("+errGrokAuthEnded.Error()+")") {
		t.Fatalf("session stop reported %q %v", line, failed)
	}
	if !errors.Is(context.Cause(ended), errGrokAuthEnded) {
		t.Fatal("cause lost")
	}
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(path); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("native fixture did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
