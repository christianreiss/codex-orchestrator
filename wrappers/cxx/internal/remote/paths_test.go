package remote

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHomeHonoursTheOverrideAndProtectsIt(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	t.Setenv(homeEnv, dir)
	got, err := Home()
	if err != nil {
		t.Fatalf("home: %v", err)
	}
	if got != dir {
		t.Fatalf("home = %q, want %q", got, dir)
	}
	info, statErr := os.Stat(dir)
	if statErr != nil {
		t.Fatalf("stat: %v", statErr)
	}
	if perm := info.Mode().Perm(); perm != 0o700 {
		t.Fatalf("mode = %04o, want 0700", perm)
	}
}

// TestHomeTightensAnExistingLooseDirectory covers the case MkdirAll does not:
// it returns nil without touching the mode of a directory that already exists,
// so a state directory left at 0755 by an older build would stay readable.
func TestHomeTightensAnExistingLooseDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatalf("prepare chmod: %v", err)
	}
	t.Setenv(homeEnv, dir)
	if _, err := Home(); err != nil {
		t.Fatalf("home: %v", err)
	}
	info, _ := os.Stat(dir)
	if perm := info.Mode().Perm(); perm != 0o700 {
		t.Fatalf("mode = %04o, want 0700", perm)
	}
}

// TestMuxPathIsStableAndSegregated pins both halves of the ControlPath
// contract: the same identity always reaches the same shared connection, and
// two identities never share one.
func TestMuxPathIsStableAndSegregated(t *testing.T) {
	t.Setenv(homeEnv, t.TempDir())
	first, err := MuxPath("deploy@build01:22")
	if err != nil {
		t.Fatalf("mux: %v", err)
	}
	again, err := MuxPath("deploy@build01:22")
	if err != nil || again != first {
		t.Fatalf("mux path is not stable: %q then %q (%v)", first, again, err)
	}
	other, err := MuxPath("deploy@build02:22")
	if err != nil {
		t.Fatalf("mux: %v", err)
	}
	if other == first {
		t.Fatalf("two identities share one control path: %q", other)
	}
}

// TestMuxPathReportsTheSocketLimitByName is the difference between a diagnosable
// failure and `bind: invalid argument`, which names nothing at all.
func TestMuxPathReportsTheSocketLimitByName(t *testing.T) {
	deep := filepath.Join(t.TempDir(), strings.Repeat("d", 60), strings.Repeat("e", 60))
	t.Setenv(homeEnv, deep)
	_, err := MuxPath("deploy@build01:22")
	if err == nil {
		t.Fatal("a control path over the socket limit was accepted")
	}
	var typed *Error
	if !asError(err, &typed) || typed.Code != CodePathTooLong {
		t.Fatalf("error = %v, want %s", err, CodePathTooLong)
	}
	if !strings.Contains(typed.Message, homeEnv) {
		t.Fatalf("message does not name the way out: %q", typed.Message)
	}
}

func TestValidJobIDRejectsAnythingThatLeavesItsDirectory(t *testing.T) {
	for _, id := range []string{"", "..", ".", ".hidden", "a/b", "a\\b", "x y", strings.Repeat("j", 65)} {
		if err := ValidJobID(id); err == nil {
			t.Fatalf("job id %q was accepted", id)
		}
	}
	for _, id := range []string{"build-api", "job_1", "v1.2.3", "A1"} {
		if err := ValidJobID(id); err != nil {
			t.Fatalf("job id %q was rejected: %v", id, err)
		}
	}
}

func TestJobDirRefusesAnEscapingID(t *testing.T) {
	t.Setenv(homeEnv, t.TempDir())
	if _, err := JobDir("../escape"); err == nil {
		t.Fatal("JobDir accepted a path separator")
	}
}
