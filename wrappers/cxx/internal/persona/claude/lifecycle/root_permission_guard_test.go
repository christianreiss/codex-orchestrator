package lifecycle

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func writeGuardSettings(t *testing.T, mode string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	body := `{"permissions":{"defaultMode":"` + mode + `"}}`
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func asRoot(t *testing.T) {
	t.Helper()
	prev := effectiveUID
	effectiveUID = func() int { return 0 }
	t.Cleanup(func() { effectiveUID = prev })
}

func asUser(t *testing.T) {
	t.Helper()
	prev := effectiveUID
	effectiveUID = func() int { return 1000 }
	t.Cleanup(func() { effectiveUID = prev })
}

// The combination this exists for: root + bypassPermissions is a launch that
// aborts, and on the relay path it aborts invisibly.
func TestRootGuardSubstitutesAStartableMode(t *testing.T) {
	asRoot(t)
	writeGuardSettings(t, "bypassPermissions")

	got := guardRootPermissionMode([]string{"-p", "--output-format", "json"}, nil)
	want := []string{"--permission-mode", "auto", "-p", "--output-format", "json"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("argv = %q, want %q", got, want)
	}
}

func TestRootGuardLeavesAStartableModeAlone(t *testing.T) {
	asRoot(t)
	for _, mode := range []string{"auto", "default", "acceptEdits", "plan", "dontAsk"} {
		writeGuardSettings(t, mode)
		args := []string{"-p"}
		if got := guardRootPermissionMode(args, nil); !reflect.DeepEqual(got, args) {
			t.Errorf("mode %q: argv = %q, want untouched %q", mode, got, args)
		}
	}
}

// A non-root user can boot bypassPermissions perfectly well, and that is the
// posture the operator asked for. Substituting there would silently weaken it.
func TestRootGuardDoesNotTouchANonRootLaunch(t *testing.T) {
	asUser(t)
	writeGuardSettings(t, "bypassPermissions")

	args := []string{"-p", "--output-format", "json"}
	if got := guardRootPermissionMode(args, nil); !reflect.DeepEqual(got, args) {
		t.Fatalf("argv = %q, want untouched %q", got, args)
	}
}

// Whoever passed a mode explicitly outranks us; they may want one we would not
// have chosen, and two --permission-mode flags is not a thing to hand upstream.
func TestRootGuardYieldsToAnExplicitFlag(t *testing.T) {
	asRoot(t)
	writeGuardSettings(t, "bypassPermissions")

	for _, args := range [][]string{
		{"--permission-mode", "default", "-p"},
		{"--permission-mode=plan", "-p"},
	} {
		if got := guardRootPermissionMode(args, nil); !reflect.DeepEqual(got, args) {
			t.Errorf("argv = %q, want untouched %q", got, args)
		}
	}
}

// A launch that was going to work must never be altered because we could not
// read or parse something.
func TestRootGuardStaysOutOfTheWayWhenSettingsAreUnreadable(t *testing.T) {
	asRoot(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	args := []string{"-p"}

	if got := guardRootPermissionMode(args, nil); !reflect.DeepEqual(got, args) {
		t.Errorf("absent settings: argv = %q, want untouched", got)
	}

	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := guardRootPermissionMode(args, nil); !reflect.DeepEqual(got, args) {
		t.Errorf("unparseable settings: argv = %q, want untouched", got)
	}
}

// The guard must never be the thing that puts the refused mode on a command
// line -- that is the exact string the relay argv test forbids.
func TestRootGuardNeverEmitsTheRefusedMode(t *testing.T) {
	asRoot(t)
	writeGuardSettings(t, "bypassPermissions")

	for _, a := range guardRootPermissionMode([]string{"-p"}, nil) {
		if a == rootGuardRefuseMode || a == "--dangerously-skip-permissions" {
			t.Fatalf("guard emitted %q", a)
		}
	}
}
