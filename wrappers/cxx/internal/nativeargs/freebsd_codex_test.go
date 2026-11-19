package nativeargs

import "testing"

func TestPfSenseRequiresSignedFullAccess(t *testing.T) {
	if CheckFreeBSDCodexLaunch(false, nil) == nil {
		t.Fatal("missing host grant accepted")
	}
	for _, args := range [][]string{{"exec", "--sandbox", "read-only"}, {"-sworkspace-write", "run"}, {"exec", "-c", "sandbox_mode='read-only'"}, {"-c", "default_permissions='limited'"}} {
		if CheckFreeBSDCodexLaunch(true, args) == nil {
			t.Fatalf("unsupported sandbox accepted: %q", args)
		}
	}
	for _, args := range [][]string{{"exec", "--sandbox", "danger-full-access", "pwd"}, {"--model", "local", "exec", "pwd"}, {"exec", "--", "--sandbox"}} {
		if err := CheckFreeBSDCodexLaunch(true, args); err != nil {
			t.Fatal(err)
		}
	}
}
