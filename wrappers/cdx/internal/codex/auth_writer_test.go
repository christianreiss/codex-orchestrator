package codex

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestBackfillLastRefreshMissingField(t *testing.T) {
	in := []byte(`{"tokens":{"access_token":"abc"}}`)
	out, modified, err := BackfillLastRefresh(in)
	if err != nil {
		t.Fatalf("BackfillLastRefresh: %v", err)
	}
	if !modified {
		t.Fatalf("expected modified=true for missing last_refresh")
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("output not valid JSON: %v", err)
	}
	stamp, ok := got["last_refresh"].(string)
	if !ok || strings.TrimSpace(stamp) == "" {
		t.Fatalf("last_refresh missing/empty after backfill: %v", got["last_refresh"])
	}
	if _, err := time.Parse(time.RFC3339, stamp); err != nil {
		t.Fatalf("last_refresh %q not RFC3339: %v", stamp, err)
	}
	if got["tokens"] == nil {
		t.Fatalf("tokens lost during backfill: %v", got)
	}
}

func TestUnsupportedDirectorySyncErrorsArePortableNoOps(t *testing.T) {
	if !unsupportedDirectorySync(syscall.EINVAL) || !unsupportedDirectorySync(syscall.ENOTSUP) {
		t.Fatal("unsupported directory fsync errors were not recognized")
	}
	if unsupportedDirectorySync(syscall.EPERM) {
		t.Fatal("real directory fsync failure was ignored")
	}
}

func TestBackfillLastRefreshEmptyField(t *testing.T) {
	in := []byte(`{"last_refresh":"   ","tokens":{}}`)
	out, modified, err := BackfillLastRefresh(in)
	if err != nil {
		t.Fatalf("BackfillLastRefresh: %v", err)
	}
	if !modified {
		t.Fatalf("expected modified=true for whitespace-only last_refresh")
	}
	var got map[string]any
	_ = json.Unmarshal(out, &got)
	if s, _ := got["last_refresh"].(string); strings.TrimSpace(s) == "" {
		t.Fatalf("last_refresh still empty after backfill: %q", s)
	}
}

func TestBackfillLastRefreshAlreadyPresentNoOp(t *testing.T) {
	in := []byte(`{"last_refresh":"2026-01-02T03:04:05Z","tokens":{}}`)
	out, modified, err := BackfillLastRefresh(in)
	if err != nil {
		t.Fatalf("BackfillLastRefresh: %v", err)
	}
	if modified {
		t.Fatalf("expected modified=false when last_refresh already set")
	}
	if string(out) != string(in) {
		t.Fatalf("payload mutated on no-op path: %s", string(out))
	}
}

func TestBackfillLastRefreshInvalidJSONPassthrough(t *testing.T) {
	in := []byte(`not json at all`)
	out, modified, err := BackfillLastRefresh(in)
	if err != nil {
		t.Fatalf("BackfillLastRefresh on invalid JSON should not error: %v", err)
	}
	if modified {
		t.Fatalf("invalid JSON must not be reported as modified")
	}
	if string(out) != string(in) {
		t.Fatalf("invalid JSON should pass through unchanged: %s", string(out))
	}
}

func TestBackfillLastRefreshEmptyInput(t *testing.T) {
	out, modified, err := BackfillLastRefresh(nil)
	if err != nil || modified || len(out) != 0 {
		t.Fatalf("nil input should produce no-op: out=%q modified=%v err=%v", out, modified, err)
	}
}

func TestAuthPathHonorsCodexHome(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, err := AuthPath()
	if err != nil || path != filepath.Join(dir, "auth.json") {
		t.Fatalf("AuthPath() = %q, %v", path, err)
	}
}

func TestReadAuthForUploadStabilizesNativeLoginOnceAcrossProcesses(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path := filepath.Join(dir, "auth.json")
	native := []byte(`{"tokens":{"access_token":"native-login"}}`)
	if err := os.WriteFile(path, native, 0o600); err != nil {
		t.Fatal(err)
	}
	fixed := time.Date(2026, 7, 17, 9, 8, 7, 123456789, time.UTC)
	if err := os.Chtimes(path, fixed, fixed); err != nil {
		t.Fatal(err)
	}

	const callers = 16
	payloads := make([]string, callers)
	generations := make([]AuthGeneration, callers)
	errs := make([]error, callers)
	var wg sync.WaitGroup
	for i := range callers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			payload, generation, err := ReadAuthForUpload()
			payloads[i], generations[i], errs[i] = string(payload), generation, err
		}(i)
	}
	wg.Wait()
	for i := range callers {
		if errs[i] != nil {
			t.Fatalf("caller %d: %v", i, errs[i])
		}
		if payloads[i] != payloads[0] || generations[i] != generations[0] {
			t.Fatalf("caller %d diverged: payload=%q generation=%+v", i, payloads[i], generations[i])
		}
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(payloads[0]), &doc); err != nil {
		t.Fatal(err)
	}
	if got := doc["last_refresh"]; got != fixed.Format(time.RFC3339Nano) {
		t.Fatalf("stable last_refresh = %v, want original mtime %s", got, fixed.Format(time.RFC3339Nano))
	}
}

func TestClampUploadTimestampMatchesServerBounds(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	min := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	if got := clampUploadTimestamp(time.Date(1990, 1, 1, 0, 0, 0, 0, time.UTC), now); !got.Equal(min) {
		t.Fatalf("old timestamp clamp = %v", got)
	}
	if got := clampUploadTimestamp(now.Add(6*time.Minute), now); !got.Equal(now) {
		t.Fatalf("future timestamp clamp = %v", got)
	}
	inside := now.Add(4 * time.Minute)
	if got := clampUploadTimestamp(inside, now); !got.Equal(inside) {
		t.Fatalf("accepted timestamp changed: %v", got)
	}
}

func TestReadAuthForUploadClampsExistingOutOfRangeStamp(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(path, []byte(`{"last_refresh":"2099-01-01T00:00:00Z","tokens":{"access_token":"valid"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	payload, _, err := ReadAuthForUpload()
	if err != nil {
		t.Fatal(err)
	}
	stamp, err := LastRefreshFromRaw(payload)
	if err != nil || !reasonableAuthTimestamp(stamp, time.Now()) {
		t.Fatalf("normalized stamp = %v, %v", stamp, err)
	}
}

func TestAuthUploadLeaseSerializesLogoutIntentAtStoreBoundary(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := AuthPath()
	if err := os.WriteFile(path, []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"login"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	lease, err := BeginAuthUpload(false)
	if err != nil {
		t.Fatal(err)
	}
	generation := lease.Generation()
	markerDone := make(chan error, 1)
	go func() {
		marked, err := MarkLogoutIntent(generation)
		if err == nil && !marked {
			err = errors.New("logout generation changed")
		}
		markerDone <- err
	}()
	select {
	case err := <-markerDone:
		t.Fatalf("logout crossed held upload boundary: %v", err)
	case <-time.After(75 * time.Millisecond):
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-markerDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("logout did not commit after upload transaction released")
	}
	if active, err := LogoutIntentActive(); err != nil || !active {
		t.Fatalf("serialized later logout active=%v err=%v", active, err)
	}
}

func TestAuthUploadLeaseRejectsPreexistingLogoutUnlessExplicitlyAcknowledged(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := AuthPath()
	if err := os.WriteFile(path, []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"login"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	generation, _ := CurrentAuthGeneration()
	if marked, err := MarkLogoutIntent(generation); err != nil || !marked {
		t.Fatalf("mark logout = %v, %v", marked, err)
	}
	if lease, err := BeginAuthUpload(false); !errors.Is(err, ErrLogoutIntentActive) || lease != nil {
		if lease != nil {
			_ = lease.Close()
		}
		t.Fatalf("ordinary upload with logout = lease=%v err=%v", lease, err)
	}

	lease, err := BeginAuthUpload(true)
	if err != nil {
		t.Fatal(err)
	}
	markerDone := make(chan error, 1)
	go func() {
		marked, err := MarkLogoutIntent(generation)
		if err == nil && !marked {
			err = errors.New("replacement logout generation changed")
		}
		markerDone <- err
	}()
	select {
	case err := <-markerDone:
		t.Fatalf("replacement logout crossed explicit upload boundary: %v", err)
	case <-time.After(75 * time.Millisecond):
	}
	if acknowledged, err := lease.AcknowledgeObservedLogout(); err != nil || !acknowledged {
		t.Fatalf("acknowledge old marker = %v, %v", acknowledged, err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-markerDone; err != nil {
		t.Fatal(err)
	}
	if active, err := LogoutIntentActive(); err != nil || !active {
		t.Fatalf("later replacement marker was erased: active=%v err=%v", active, err)
	}
}

func TestDifferentUsableLoginMayUploadButClearsLogoutOnlyAfterAcceptance(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := AuthPath()
	if err := os.WriteFile(path, []byte(`{"last_refresh":"2026-07-17T09:00:00Z","tokens":{"access_token":"old"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	old, _ := CurrentAuthGeneration()
	if marked, err := MarkLogoutIntent(old); err != nil || !marked {
		t.Fatalf("mark logout = %v, %v", marked, err)
	}
	if err := os.WriteFile(path, []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"new"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	lease, err := BeginAuthUpload(false)
	if err != nil {
		t.Fatalf("different login was not uploadable: %v", err)
	}
	if !lease.IntentGeneration().Exists {
		t.Fatal("upload lost the logout marker generation it must acknowledge")
	}
	if _, err := os.Stat(logoutIntentPath(path)); err != nil {
		t.Fatalf("mere local login cleared marker before server acceptance: %v", err)
	}
	if acknowledged, err := lease.AcknowledgeObservedLogout(); err != nil || !acknowledged {
		t.Fatalf("accepted candidate acknowledgement = %v, %v", acknowledged, err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if active, err := LogoutIntentActive(); err != nil || active {
		t.Fatalf("server-accepted changed login did not clear marker: active=%v err=%v", active, err)
	}
}

func TestLastRefreshStabilizationCannotMasqueradeAsLoginOverLogout(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := AuthPath()
	// Native Codex login bytes have no wrapper-owned last_refresh yet.
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"same-native-login"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	generation, _ := CurrentAuthGeneration()
	if marked, err := MarkLogoutIntent(generation); err != nil || !marked {
		t.Fatalf("mark logout = %v, %v", marked, err)
	}
	if lease, err := BeginAuthUpload(false); !errors.Is(err, ErrLogoutIntentActive) || lease != nil {
		if lease != nil {
			_ = lease.Close()
		}
		t.Fatalf("stamp-only generation bypassed logout: lease=%v err=%v", lease, err)
	}
	if active, err := LogoutIntentActive(); err != nil || !active {
		t.Fatalf("stamp-only generation cleared logout: active=%v err=%v", active, err)
	}
}

func TestWriteAuthIfCurrentDoesNotClobberNewerNativeLogin(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path := filepath.Join(dir, "auth.json")
	old := []byte(`{"last_refresh":"2026-07-17T08:00:00Z","tokens":{"access_token":"old"}}`)
	if err := os.WriteFile(path, old, 0o600); err != nil {
		t.Fatal(err)
	}
	expected, err := CurrentAuthGeneration()
	if err != nil {
		t.Fatal(err)
	}
	newLogin := []byte(`{"tokens":{"access_token":"new-login"}}`)
	if err := os.WriteFile(path, newLogin, 0o600); err != nil {
		t.Fatal(err)
	}
	wrote, err := WriteAuthIfCurrent(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"server"}}`), expected)
	if err != nil || wrote {
		t.Fatalf("WriteAuthIfCurrent = %v, %v; want skipped", wrote, err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != string(newLogin) {
		t.Fatalf("new login was clobbered: %s", raw)
	}
}

func TestWriteAuthIfCurrentOnlyOneConcurrentResponseWins(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(`{"tokens":{"access_token":"old"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	expected, _ := CurrentAuthGeneration()
	const writers = 12
	results := make(chan bool, writers)
	errs := make(chan error, writers)
	var wg sync.WaitGroup
	for i := range writers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			payload := json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"server-` + fmt.Sprint(i) + `"}}`)
			wrote, err := WriteAuthIfCurrent(payload, expected)
			results <- wrote
			errs <- err
		}(i)
	}
	wg.Wait()
	close(results)
	close(errs)
	wins := 0
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	for wrote := range results {
		if wrote {
			wins++
		}
	}
	if wins != 1 {
		t.Fatalf("concurrent generation writes = %d, want exactly one", wins)
	}
}

func TestLogoutIntentBlocksCanonicalAndSurvivesUnacknowledgedNewFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"old"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	generation, _ := CurrentAuthGeneration()
	marked, err := MarkLogoutIntent(generation)
	if err != nil || !marked {
		t.Fatalf("MarkLogoutIntent = %v, %v", marked, err)
	}
	if active, err := LogoutIntentActive(); err != nil || !active {
		t.Fatalf("LogoutIntentActive = %v, %v", active, err)
	}
	if wrote, err := WriteAuthIfCurrent(json.RawMessage(`{"tokens":{"access_token":"late-server-response"}}`), generation); err != nil || wrote {
		t.Fatalf("active logout marker allowed in-flight server write: wrote=%v err=%v", wrote, err)
	}
	if err := WriteAuth(json.RawMessage(`{"tokens":{"access_token":"unconditional-server-response"}}`)); !errors.Is(err, ErrLogoutIntentActive) {
		t.Fatalf("active logout marker allowed unconditional server write: %v", err)
	}
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"new"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if active, err := LogoutIntentActive(); err != nil || !active {
		t.Fatalf("unacknowledged file change cleared logout intent: active=%v err=%v", active, err)
	}
}

func TestLogoutIntentCASDoesNotClearNewerSameGenerationLogout(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"same-generation"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	expected, _ := CurrentAuthGeneration()
	if marked, err := MarkLogoutIntent(expected); err != nil || !marked {
		t.Fatalf("first marker = %v, %v", marked, err)
	}
	first, err := CurrentLogoutIntentGeneration()
	if err != nil {
		t.Fatal(err)
	}
	if marked, err := MarkLogoutIntent(expected); err != nil || !marked {
		t.Fatalf("second marker = %v, %v", marked, err)
	}
	second, err := CurrentLogoutIntentGeneration()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatalf("same-generation logout markers reused CAS identity: %+v", first)
	}
	if cleared, err := ClearLogoutIntentIfUnchanged(expected, first); err != nil || cleared {
		t.Fatalf("old upload cleared newer logout: cleared=%v err=%v", cleared, err)
	}
	if active, err := LogoutIntentActive(); err != nil || !active {
		t.Fatalf("newer logout intent not preserved: active=%v err=%v", active, err)
	}
}
