package claude

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

var (
	switchFirst  = json.RawMessage(`{"last_refresh":"2026-11-26T10:00:00Z","claudeAiOauth":{"accessToken":"first-account","refreshToken":"first-refresh","expiresAt":4102444800000}}`)
	switchSecond = json.RawMessage(`{"last_refresh":"2026-11-20T10:00:00Z","claudeAiOauth":{"accessToken":"second-account","refreshToken":"second-refresh","expiresAt":4102444800000}}`)
)

func switchFixture(t *testing.T) AuthSnapshot {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	if err := WriteAuth(switchFirst); err != nil {
		t.Fatal(err)
	}
	snap, err := ReadAuthForRetrieveSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	return snap
}

func TestSwitchedAccountWriterWorksWhileChildRuns(t *testing.T) {
	before := switchFixture(t)
	child, err := acquireAuthChildShared()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Close() })
	canonical := "1111111111111111111111111111111111111111111111111111111111111111"
	generation, wrote, err := WriteSwitchedAccountIfCurrent(context.Background(), switchSecond, canonical, "verified", before.Generation)
	if err != nil || !wrote {
		t.Fatalf("switch with active child: wrote=%v err=%v", wrote, err)
	}
	after, err := ReadAuthForRetrieveSnapshot()
	if err != nil || after.Generation != generation || !SameCredentialPair(after.Raw, switchSecond) {
		t.Fatalf("switched credentials not on disk: %+v %v", after.Generation, err)
	}
	// An older last_refresh than the previous account is no obstacle, and the
	// new head counts as server-confirmed for the next session sync.
	if after.ServerDigest != canonical {
		t.Fatalf("generation state not committed: %q", after.ServerDigest)
	}
}

func TestSwitchedAccountWriterRefusesNativeRotation(t *testing.T) {
	before := switchFixture(t)
	rotated := json.RawMessage(`{"claudeAiOauth":{"accessToken":"first-rotated","refreshToken":"first-refresh-2","expiresAt":4102444800000}}`)
	if err := os.WriteFile(before.Path, rotated, 0o600); err != nil {
		t.Fatal(err)
	}
	_, wrote, err := WriteSwitchedAccountIfCurrent(context.Background(), switchSecond, "", "verified", before.Generation)
	if err != nil || wrote {
		t.Fatalf("CAS conflict wrote=%v err=%v", wrote, err)
	}
	raw, _ := os.ReadFile(before.Path)
	if !SameCredentialPair(raw, rotated) {
		t.Fatal("native rotation overwritten")
	}
}

func TestSwitchedAccountWriterRespectsLogoutAndVerification(t *testing.T) {
	before := switchFixture(t)
	if _, wrote, err := WriteSwitchedAccountIfCurrent(context.Background(), switchSecond, "", "pending", before.Generation); err != nil || wrote {
		t.Fatalf("unverified switch wrote=%v err=%v", wrote, err)
	}
	marked, err := RecordDeferredExplicitLogout(before.Generation)
	if err != nil || !marked {
		t.Fatalf("logout marked=%v err=%v", marked, err)
	}
	_, wrote, err := WriteSwitchedAccountIfCurrent(context.Background(), switchSecond, "", "verified", before.Generation)
	if err != nil || wrote {
		t.Fatalf("switch over logout intent wrote=%v err=%v", wrote, err)
	}
	if !HasLogoutIntent() {
		t.Fatal("logout intent cleared by a live switch")
	}
}
