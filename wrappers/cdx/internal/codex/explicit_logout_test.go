package codex

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

// explicitLogoutHome points the package at a temp CODEX_HOME and returns the
// auth.json path inside it.
func explicitLogoutHome(t *testing.T) string {
	t.Helper()
	t.Setenv("CODEX_HOME", t.TempDir())
	path, err := AuthPath()
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func writeExplicitLogoutAuth(t *testing.T, path, token string) AuthGeneration {
	t.Helper()
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"`+token+`"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	generation, err := authGenerationAt(path)
	if err != nil {
		t.Fatal(err)
	}
	return generation
}

func explicitLogoutMarker(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(logoutIntentPath(path))
	if err != nil {
		t.Fatalf("read logout intent marker: %v", err)
	}
	return raw
}

func TestBeginExplicitLogoutRejectsNewerUsableLogin(t *testing.T) {
	path := explicitLogoutHome(t)
	before := writeExplicitLogoutAuth(t, path, "old")
	writeExplicitLogoutAuth(t, path, "new")

	guard, err := beginExplicitLogout(before)
	if !errors.Is(err, errAuthChangedBeforeLogout) || guard != nil {
		t.Fatalf("beginExplicitLogout = %v, %v; want errAuthChangedBeforeLogout", guard, err)
	}
	if _, err := os.Stat(logoutIntentPath(path)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("refused logout journaled intent anyway: %v", err)
	}
}

func TestBeginExplicitLogoutJournalsIntentForUnchangedGeneration(t *testing.T) {
	path := explicitLogoutHome(t)
	before := writeExplicitLogoutAuth(t, path, "current")

	guard, err := beginExplicitLogout(before)
	if err != nil || guard == nil {
		t.Fatalf("beginExplicitLogout = %v, %v", guard, err)
	}
	if guard.path != path || guard.before != before {
		t.Fatalf("guard snapshot = %+v; want path %q generation %+v", guard, path, before)
	}
	if len(guard.previousMarker) != 0 {
		t.Fatalf("captured a previous marker that never existed: %s", guard.previousMarker)
	}
	onDisk, err := logoutIntentGenerationAt(path)
	if err != nil {
		t.Fatal(err)
	}
	if !guard.intent.Exists || onDisk != guard.intent {
		t.Fatalf("journaled intent = %+v, on disk = %+v", guard.intent, onDisk)
	}
	var marker logoutIntent
	if err := json.Unmarshal(explicitLogoutMarker(t, path), &marker); err != nil {
		t.Fatal(err)
	}
	if !marker.AuthExists || marker.AuthDigest != before.Digest {
		t.Fatalf("marker pins %+v; want the pre-logout generation %+v", marker, before)
	}
}

func TestBeginExplicitLogoutCapturesExistingMarkerAsPrevious(t *testing.T) {
	path := explicitLogoutHome(t)
	before := writeExplicitLogoutAuth(t, path, "current")
	if marked, err := MarkLogoutIntent(before); err != nil || !marked {
		t.Fatalf("seed marker = %v, %v", marked, err)
	}
	previous := explicitLogoutMarker(t, path)

	guard, err := beginExplicitLogout(before)
	if err != nil || guard == nil {
		t.Fatalf("beginExplicitLogout = %v, %v", guard, err)
	}
	if string(guard.previousMarker) != string(previous) {
		t.Fatalf("previousMarker = %s; want the marker found on entry %s", guard.previousMarker, previous)
	}
	if string(explicitLogoutMarker(t, path)) == string(previous) {
		t.Fatal("logout reused the prior marker instead of journaling its own")
	}
}

func TestRecordDeferredExplicitLogoutMarksUnchangedGeneration(t *testing.T) {
	path := explicitLogoutHome(t)
	before := writeExplicitLogoutAuth(t, path, "current")

	marked, err := recordDeferredExplicitLogout(before)
	if err != nil || !marked {
		t.Fatalf("recordDeferredExplicitLogout = %v, %v", marked, err)
	}
	if active, err := LogoutIntentActive(); err != nil || !active {
		t.Fatalf("deferred logout intent active = %v, %v", active, err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("deferred logout removed auth before the final peer exit: %v", err)
	}
}

func TestRecordDeferredExplicitLogoutSkipsNewerUsableLogin(t *testing.T) {
	path := explicitLogoutHome(t)
	before := writeExplicitLogoutAuth(t, path, "old")
	writeExplicitLogoutAuth(t, path, "new")

	marked, err := recordDeferredExplicitLogout(before)
	if err != nil || marked {
		t.Fatalf("recordDeferredExplicitLogout = %v, %v; want unmarked", marked, err)
	}
	if _, err := os.Stat(logoutIntentPath(path)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("skipped deferred logout journaled intent anyway: %v", err)
	}
}

func TestExplicitLogoutGuardFinishSuccessRemovesAuthAndKeepsIntent(t *testing.T) {
	path := explicitLogoutHome(t)
	before := writeExplicitLogoutAuth(t, path, "current")
	guard, err := beginExplicitLogout(before)
	if err != nil || guard == nil {
		t.Fatalf("beginExplicitLogout = %v, %v", guard, err)
	}
	journaled := explicitLogoutMarker(t, path)

	marked, err := guard.finish(true)
	if err != nil || !marked {
		t.Fatalf("finish(true) = %v, %v", marked, err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("successful logout left auth.json behind: %v", err)
	}
	if string(explicitLogoutMarker(t, path)) != string(journaled) {
		t.Fatal("successful logout did not leave its durable intent")
	}
}

func TestExplicitLogoutGuardFinishFailureRestoresPriorMarker(t *testing.T) {
	path := explicitLogoutHome(t)
	before := writeExplicitLogoutAuth(t, path, "current")
	if marked, err := MarkLogoutIntent(before); err != nil || !marked {
		t.Fatalf("seed marker = %v, %v", marked, err)
	}
	previous := explicitLogoutMarker(t, path)
	guard, err := beginExplicitLogout(before)
	if err != nil || guard == nil {
		t.Fatalf("beginExplicitLogout = %v, %v", guard, err)
	}

	marked, err := guard.finish(false)
	if err != nil || !marked {
		t.Fatalf("finish(false) = %v, %v; want the older intent reported active", marked, err)
	}
	if got := explicitLogoutMarker(t, path); string(got) != string(previous) {
		t.Fatalf("restored marker = %s; want the exact prior marker %s", got, previous)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("failed logout removed auth anyway: %v", err)
	}
}

func TestExplicitLogoutGuardFinishFailureWithoutPriorMarkerRemovesIntent(t *testing.T) {
	path := explicitLogoutHome(t)
	before := writeExplicitLogoutAuth(t, path, "current")
	guard, err := beginExplicitLogout(before)
	if err != nil || guard == nil {
		t.Fatalf("beginExplicitLogout = %v, %v", guard, err)
	}

	marked, err := guard.finish(false)
	if err != nil || marked {
		t.Fatalf("finish(false) = %v, %v; want no invented intent", marked, err)
	}
	if _, err := os.Stat(logoutIntentPath(path)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed logout kept its own marker: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("failed logout removed auth anyway: %v", err)
	}
}

func TestExplicitLogoutGuardFinishLeavesForeignIntentUntouched(t *testing.T) {
	path := explicitLogoutHome(t)
	before := writeExplicitLogoutAuth(t, path, "current")
	guard, err := beginExplicitLogout(before)
	if err != nil || guard == nil {
		t.Fatalf("beginExplicitLogout = %v, %v", guard, err)
	}
	if marked, err := MarkLogoutIntent(before); err != nil || !marked {
		t.Fatalf("foreign marker = %v, %v", marked, err)
	}
	foreign := explicitLogoutMarker(t, path)

	marked, err := guard.finish(true)
	if err != nil || !marked {
		t.Fatalf("finish(true) under foreign intent = %v, %v", marked, err)
	}
	if got := explicitLogoutMarker(t, path); string(got) != string(foreign) {
		t.Fatalf("marker owned by another transaction was rewritten: %s", got)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("auth governed by a foreign marker was removed: %v", err)
	}
}

func TestExplicitLogoutGuardFinishNilGuardIsNoOp(t *testing.T) {
	var guard *explicitLogoutGuard
	marked, err := guard.finish(true)
	if marked || err != nil {
		t.Fatalf("nil guard finish = %v, %v", marked, err)
	}
}

func TestCompleteDeferredLogoutWithoutMarkerKeepsAuth(t *testing.T) {
	path := explicitLogoutHome(t)
	writeExplicitLogoutAuth(t, path, "current")

	removed, err := completeDeferredLogoutLocked(path)
	if err != nil || removed {
		t.Fatalf("completeDeferredLogoutLocked = %v, %v; want no-op without a marker", removed, err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("auth removed without any logout intent: %v", err)
	}
}

func TestCompleteDeferredLogoutWithoutAuthKeepsMarker(t *testing.T) {
	path := explicitLogoutHome(t)
	before := writeExplicitLogoutAuth(t, path, "current")
	if marked, err := MarkLogoutIntent(before); err != nil || !marked {
		t.Fatalf("mark logout = %v, %v", marked, err)
	}
	journaled := explicitLogoutMarker(t, path)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	removed, err := completeDeferredLogoutLocked(path)
	if err != nil || removed {
		t.Fatalf("completeDeferredLogoutLocked = %v, %v; want nothing to remove", removed, err)
	}
	if got := explicitLogoutMarker(t, path); string(got) != string(journaled) {
		t.Fatalf("marker changed while completing an already-empty auth: %s", got)
	}
}

func TestCompleteDeferredLogoutPreservesNewerUsableLogin(t *testing.T) {
	path := explicitLogoutHome(t)
	before := writeExplicitLogoutAuth(t, path, "old")
	if marked, err := MarkLogoutIntent(before); err != nil || !marked {
		t.Fatalf("mark logout = %v, %v", marked, err)
	}
	journaled := explicitLogoutMarker(t, path)
	newer := writeExplicitLogoutAuth(t, path, "new")

	removed, err := completeDeferredLogoutLocked(path)
	if err != nil || removed {
		t.Fatalf("completeDeferredLogoutLocked = %v, %v; want the candidate login preserved", removed, err)
	}
	current, err := authGenerationAt(path)
	if err != nil {
		t.Fatal(err)
	}
	if current != newer {
		t.Fatalf("newer login = %+v; want it left intact as %+v", current, newer)
	}
	if got := explicitLogoutMarker(t, path); string(got) != string(journaled) {
		t.Fatalf("marker cleared by a merely local login: %s", got)
	}
}

func TestCompleteDeferredLogoutRemovesMarkedAuthAndKeepsMarker(t *testing.T) {
	path := explicitLogoutHome(t)
	before := writeExplicitLogoutAuth(t, path, "current")
	if marked, err := MarkLogoutIntent(before); err != nil || !marked {
		t.Fatalf("mark logout = %v, %v", marked, err)
	}
	journaled := explicitLogoutMarker(t, path)

	removed, err := completeDeferredLogoutLocked(path)
	if err != nil || !removed {
		t.Fatalf("completeDeferredLogoutLocked = %v, %v; want the marked generation removed", removed, err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("marked auth survived deferred completion: %v", err)
	}
	if got := explicitLogoutMarker(t, path); string(got) != string(journaled) {
		t.Fatalf("marker dropped after removal, allowing canonical retrieve to undo logout: %s", got)
	}
}
