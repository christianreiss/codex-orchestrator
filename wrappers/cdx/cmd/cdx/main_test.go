package main

import (
	"bytes"
	"strings"
	"testing"
)

// TestRunRefusesAfterMaxRestartDepth verifies the cdx run() entrypoint
// short-circuits with a non-zero exit when
// CODEX_WRAPPER_RESTART_DEPTH > maxRestartDepth — preventing a self-update
// feedback loop from looping forever on a broken host.
func TestRunRefusesAfterMaxRestartDepth(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTART_DEPTH", "5")
	var stdout, stderr bytes.Buffer
	code := run([]string{"--version"}, &stdout, &stderr)
	if code == 0 {
		t.Fatalf("expected non-zero exit; got %d (stderr=%q)", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "restart depth") {
		t.Errorf("missing restart-depth message: %q", stderr.String())
	}
}

// TestRunAcceptsDepthAtCap verifies depth == maxRestartDepth is still
// allowed (the cap is exclusive — guard fires when depth > cap).
func TestRunAcceptsDepthAtCap(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTART_DEPTH", "2")
	var stdout, stderr bytes.Buffer
	code := run([]string{"--version"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("expected version flag to succeed; got code=%d stderr=%q", code, stderr.String())
	}
}

// TestRunSnapshotsArgv verifies the package var update.SnapshottedArgv
// reflects argv at process entry, before parseFlags touches anything.
func TestRunSnapshotsArgv(t *testing.T) {
	t.Setenv("CODEX_WRAPPER_RESTART_DEPTH", "")
	var stdout, stderr bytes.Buffer
	args := []string{"--version", "--debug"}
	_ = run(args, &stdout, &stderr)
	got := snapshottedArgvForTest()
	if len(got) != len(args) {
		t.Fatalf("snapshot len=%d want %d (%v)", len(got), len(args), got)
	}
	for i := range args {
		if got[i] != args[i] {
			t.Errorf("snapshot[%d]=%q want %q", i, got[i], args[i])
		}
	}
}
