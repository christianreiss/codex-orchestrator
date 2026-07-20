package claude

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestAuthPathIsAlwaysClaudeNative(t *testing.T) {
	cases := []struct {
		name       string
		setupClx   bool
		setupClaud bool
	}{
		{
			name:       "neither_exists_falls_back_to_claude",
			setupClx:   false,
			setupClaud: false,
		},
		{
			name:       "only_claude_exists_returns_claude",
			setupClx:   false,
			setupClaud: true,
		},
		{
			name:       "only_clx_exists_returns_clx",
			setupClx:   true,
			setupClaud: false,
		},
		{
			name:       "both_exist_claude_wins_tie",
			setupClx:   true,
			setupClaud: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)

			if tc.setupClx {
				dir := filepath.Join(home, ".clx", "auth")
				if err := os.MkdirAll(dir, 0o700); err != nil {
					t.Fatalf("mkdir clx: %v", err)
				}
				if err := os.WriteFile(filepath.Join(dir, "credentials.json"), []byte(`{"api_key":"clx-key"}`), 0o600); err != nil {
					t.Fatalf("write clx: %v", err)
				}
			}
			if tc.setupClaud {
				dir := filepath.Join(home, ".claude")
				if err := os.MkdirAll(dir, 0o700); err != nil {
					t.Fatalf("mkdir claude: %v", err)
				}
				if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), []byte(`{"api_key":"claude-key"}`), 0o600); err != nil {
					t.Fatalf("write claude: %v", err)
				}
			}

			got, err := AuthPath()
			if err != nil {
				t.Fatalf("AuthPath: %v", err)
			}
			want := filepath.Join(home, ".claude", ".credentials.json")
			if got != want {
				t.Errorf("AuthPath() = %q, want %q", got, want)
			}
		})
	}
}

func TestSidecarNeverSupersedesMissingOrInvalidNativeAuth(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	claudeDir := filepath.Join(home, ".claude")
	clxDir := filepath.Join(home, ".clx", "auth")
	if err := os.MkdirAll(claudeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(clxDir, 0o700); err != nil {
		t.Fatal(err)
	}
	claudePath := filepath.Join(claudeDir, ".credentials.json")
	clxPath := filepath.Join(clxDir, "credentials.json")
	if err := os.WriteFile(claudePath, []byte(`{"api_key":"claude-key"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(clxPath, []byte(`{"api_key":"clx-key"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(claudePath, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if HasUsableAuth() {
		t.Fatal("usable sidecar green-lit invalid native Claude credentials")
	}
	if err := os.Remove(claudePath); err != nil {
		t.Fatal(err)
	}
	if HasUsableAuth() {
		t.Fatal("usable sidecar green-lit missing native Claude credentials")
	}
	if _, err := ReadAuth(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("ReadAuth used sidecar after native logout: %v", err)
	}
}

// TestWriteAuthCreatesParentDir verifies WriteAuth always lands where upstream
// Claude Code reads credentials on first use.
func TestWriteAuthCreatesParentDirForClaudeFallback(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	payload := json.RawMessage(`{"api_key":"abc"}`)
	if err := WriteAuth(payload); err != nil {
		t.Fatalf("WriteAuth: %v", err)
	}
	dst := filepath.Join(home, ".claude", ".credentials.json")
	raw, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read written file: %v", err)
	}
	if string(raw) != `{"api_key":"abc"}` {
		t.Errorf("written payload = %q", raw)
	}
}

func TestWriteAuthHonoursClxPathWhenPreStaged(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	dir := filepath.Join(home, ".clx", "auth")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir clx: %v", err)
	}
	// Seed an empty placeholder so AuthPath chooses the clx location.
	if err := os.WriteFile(filepath.Join(dir, "credentials.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	payload := json.RawMessage(`{"api_key":"new"}`)
	if err := WriteAuth(payload); err != nil {
		t.Fatalf("WriteAuth: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "credentials.json"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(raw) != `{"api_key":"new"}` {
		t.Errorf("clx location not updated: %q", raw)
	}
	claudeRaw, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
	if err != nil {
		t.Fatalf("read claude mirror: %v", err)
	}
	if string(claudeRaw) != `{"api_key":"new"}` {
		t.Errorf("claude location not mirrored: %q", claudeRaw)
	}
}

func TestReadAuthForUploadBackfillsLastRefreshOnlyInMemory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ".credentials.json")
	original := `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-abc","refreshToken":"r"}}`
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	raw, gotPath, err := ReadAuthForUpload()
	if err != nil {
		t.Fatalf("ReadAuthForUpload: %v", err)
	}
	if gotPath != path {
		t.Fatalf("path = %q, want %q", gotPath, path)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("upload json: %v", err)
	}
	if out["last_refresh"] == "" {
		t.Fatalf("last_refresh missing in upload payload: %s", raw)
	}
	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != original {
		t.Fatalf("ReadAuthForUpload mutated disk: %s", onDisk)
	}
}

func TestReadAuthForUploadUsesOneStableGenerationAcrossConcurrentReaders(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ".credentials.json")
	if err := os.WriteFile(path, []byte(`{"claudeAiOauth":{"accessToken":"same"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	const readers = 24
	stamps := make(chan string, readers)
	errs := make(chan error, readers)
	var wg sync.WaitGroup
	for range readers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			snap, err := ReadAuthForUploadSnapshot()
			if err != nil {
				errs <- err
				return
			}
			stamps <- lastRefreshFromPayload(snap.Upload)
		}()
	}
	wg.Wait()
	close(errs)
	close(stamps)
	for err := range errs {
		t.Fatal(err)
	}
	want := ""
	for stamp := range stamps {
		if want == "" {
			want = stamp
		}
		if stamp != want {
			t.Fatalf("same native digest received divergent stamps: %q != %q", stamp, want)
		}
	}
	if want == "" {
		t.Fatal("stable last_refresh was empty")
	}
}

func TestReadAuthForUploadReplacesImplausibleFutureGenerationMetadata(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	nativeDir := filepath.Join(home, ".claude")
	stateDir := filepath.Join(home, ".clx", "auth")
	if err := os.MkdirAll(nativeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"claudeAiOauth":{"accessToken":"same"}}`)
	if err := os.WriteFile(filepath.Join(nativeDir, ".credentials.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	state, err := json.Marshal(generationState{Digest: digestBytes(raw), LastRefresh: "2099-01-01T00:00:00Z"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, generationStateFile), state, 0o600); err != nil {
		t.Fatal(err)
	}
	snap, err := ReadAuthForUploadSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	stamp := lastRefreshFromPayload(snap.Upload)
	parsed, err := time.Parse(time.RFC3339Nano, stamp)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.After(time.Now().UTC().Add(5 * time.Minute)) {
		t.Fatalf("future generation metadata survived: %s", stamp)
	}
}

func TestLegacyCanonicalGenerationSurvivesClockRollbackAndMigrates(t *testing.T) {
	for _, tc := range []struct {
		name       string
		rotate     bool
		wantStrict bool
	}{
		{name: "matching X is reused", rotate: false},
		{name: "raw Y advances after X", rotate: true, wantStrict: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			nativeDir := filepath.Join(home, ".claude")
			stateDir := filepath.Join(home, ".clx", "auth")
			if err := os.MkdirAll(nativeDir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(stateDir, 0o700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(nativeDir, ".credentials.json")
			x := []byte(`{"claudeAiOauth":{"accessToken":"native-x"}}`)
			if err := os.WriteFile(path, x, 0o600); err != nil {
				t.Fatal(err)
			}
			xStamp := time.Now().UTC().Add(30 * time.Minute).Truncate(time.Microsecond)
			legacy := generationState{
				Digest:          digestBytes(x),
				LastRefresh:     xStamp.Format(time.RFC3339Nano),
				CanonicalDigest: strings.Repeat("a", 64),
			}
			legacyRaw, err := json.Marshal(legacy)
			if err != nil {
				t.Fatal(err)
			}
			statePath := filepath.Join(stateDir, generationStateFile)
			if err := os.WriteFile(statePath, legacyRaw, 0o600); err != nil {
				t.Fatal(err)
			}
			currentDigest := legacy.Digest
			if tc.rotate {
				y := []byte(`{"claudeAiOauth":{"accessToken":"native-y"}}`)
				if err := os.WriteFile(path, y, 0o600); err != nil {
					t.Fatal(err)
				}
				rolledBack := time.Now().UTC().Add(-24 * time.Hour)
				if err := os.Chtimes(path, rolledBack, rolledBack); err != nil {
					t.Fatal(err)
				}
				currentDigest = digestBytes(y)
			}

			snap, err := ReadAuthForUploadSnapshot()
			if err != nil {
				t.Fatal(err)
			}
			stamp, err := time.Parse(time.RFC3339Nano, lastRefreshFromPayload(snap.Upload))
			if err != nil {
				t.Fatal(err)
			}
			if tc.wantStrict && !stamp.After(xStamp) {
				t.Fatalf("rotated legacy generation stamp=%s want after %s", stamp, xStamp)
			}
			if !tc.wantStrict && !stamp.Equal(xStamp) {
				t.Fatalf("matching legacy generation stamp=%s want %s", stamp, xStamp)
			}
			migratedRaw, err := os.ReadFile(statePath)
			if err != nil {
				t.Fatal(err)
			}
			var migrated generationState
			if err := json.Unmarshal(migratedRaw, &migrated); err != nil {
				t.Fatal(err)
			}
			if migrated.Version != generationStateVersion || migrated.Digest != currentDigest {
				t.Fatalf("migrated generation state=%+v want version=%d digest=%s", migrated, generationStateVersion, currentDigest)
			}
		})
	}
}

func TestWriteAuthIfCurrentPreservesLoginWrittenDuringRequest(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ".credentials.json")
	if err := os.WriteFile(path, []byte(`{"claudeAiOauth":{"accessToken":"old"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	request, err := ReadAuthForUploadSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	login := `{"claudeAiOauth":{"accessToken":"new-login"}}`
	if err := os.WriteFile(path, []byte(login), 0o600); err != nil {
		t.Fatal(err)
	}
	applied, err := WriteAuthIfCurrent(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"old"}}`), request.Generation)
	if err != nil {
		t.Fatal(err)
	}
	if applied {
		t.Fatal("stale response overwrote a newer Claude login")
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != login {
		t.Fatalf("new login not preserved: raw=%q err=%v", raw, err)
	}
}

func TestCanonicalResponsesForSameRequestConvergeMonotonically(t *testing.T) {
	for _, order := range []struct {
		name     string
		payloads []json.RawMessage
		applied  []bool
	}{
		{
			name: "older then newer",
			payloads: []json.RawMessage{
				json.RawMessage(`{"last_refresh":"2026-07-17T08:00:00Z","claudeAiOauth":{"accessToken":"canonical-old"}}`),
				json.RawMessage(`{"last_refresh":"2026-07-17T09:00:00Z","claudeAiOauth":{"accessToken":"canonical-new"}}`),
			},
			applied: []bool{true, true},
		},
		{
			name: "newer then older",
			payloads: []json.RawMessage{
				json.RawMessage(`{"last_refresh":"2026-07-17T09:00:00Z","claudeAiOauth":{"accessToken":"canonical-new"}}`),
				json.RawMessage(`{"last_refresh":"2026-07-17T08:00:00Z","claudeAiOauth":{"accessToken":"canonical-old"}}`),
			},
			applied: []bool{true, false},
		},
	} {
		t.Run(order.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			path, err := AuthPath()
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(`{"claudeAiOauth":{"accessToken":"request-local"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			request, err := ReadAuthForUploadSnapshot()
			if err != nil {
				t.Fatal(err)
			}
			for i, payload := range order.payloads {
				applied, err := WriteAuthIfCurrentWithDigest(payload, strings.Repeat(string(rune('a'+i)), 64), request.Generation)
				if err != nil || applied != order.applied[i] {
					t.Fatalf("response %d applied=%v err=%v want=%v", i, applied, err, order.applied[i])
				}
			}
			raw, err := os.ReadFile(path)
			if err != nil || !strings.Contains(string(raw), "canonical-new") {
				t.Fatalf("canonical responses did not converge to newest: %q err=%v", raw, err)
			}
		})
	}
}

func TestEqualStampDifferentCanonicalResponsesFailClosedInEitherOrder(t *testing.T) {
	for _, order := range []struct {
		name   string
		first  string
		second string
	}{
		{name: "a then b", first: "canonical-a", second: "canonical-b"},
		{name: "b then a", first: "canonical-b", second: "canonical-a"},
	} {
		t.Run(order.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			path, err := AuthPath()
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(`{"claudeAiOauth":{"accessToken":"request-local"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			request, err := ReadAuthForUploadSnapshot()
			if err != nil {
				t.Fatal(err)
			}
			payload := func(token string) json.RawMessage {
				return json.RawMessage(fmt.Sprintf(`{"last_refresh":"2026-07-17T08:00:00Z","claudeAiOauth":{"accessToken":%q}}`, token))
			}
			first := payload(order.first)
			if applied, err := WriteAuthIfCurrentWithDigest(first, strings.Repeat("a", 64), request.Generation); err != nil || !applied {
				t.Fatalf("first response applied=%v err=%v", applied, err)
			}
			second := payload(order.second)
			if applied, err := WriteAuthIfCurrentWithDigest(second, strings.Repeat("b", 64), request.Generation); err != nil || applied {
				t.Fatalf("equal-stamp second response applied=%v err=%v", applied, err)
			}
			if err := BlockedCanonicalWriteError(request, second, false); err == nil || !strings.Contains(err.Error(), "ambiguous") {
				t.Fatalf("equal-stamp ambiguity error=%v", err)
			}
			raw, err := os.ReadFile(path)
			if err != nil || !strings.Contains(string(raw), order.first) {
				t.Fatalf("ambiguous response changed first canonical: %q err=%v", raw, err)
			}
		})
	}
}

func TestCanonicalResponseConvergencePreservesRawLoginAndLogout(t *testing.T) {
	for _, tc := range []struct {
		name        string
		mutate      func(t *testing.T, path string)
		want        string
		wantMissing bool
	}{
		{
			name: "raw newer login",
			mutate: func(t *testing.T, path string) {
				if err := os.WriteFile(path, []byte(`{"claudeAiOauth":{"accessToken":"raw-login"}}`), 0o600); err != nil {
					t.Fatal(err)
				}
			},
			want: "raw-login",
		},
		{
			name: "logout intent",
			mutate: func(t *testing.T, _ string) {
				current, err := ReadAuthSnapshot(false)
				if err != nil {
					t.Fatal(err)
				}
				if marked, err := RecordDeferredExplicitLogout(current.Generation); err != nil || !marked {
					t.Fatalf("record logout=%v err=%v", marked, err)
				}
			},
			wantMissing: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			path, err := AuthPath()
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(`{"claudeAiOauth":{"accessToken":"request-local"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			request, err := ReadAuthForUploadSnapshot()
			if err != nil {
				t.Fatal(err)
			}
			old := json.RawMessage(`{"last_refresh":"2026-07-17T08:00:00Z","claudeAiOauth":{"accessToken":"canonical-old"}}`)
			if applied, err := WriteAuthIfCurrentWithDigest(old, strings.Repeat("a", 64), request.Generation); err != nil || !applied {
				t.Fatalf("initial canonical applied=%v err=%v", applied, err)
			}
			tc.mutate(t, path)
			newer := json.RawMessage(`{"last_refresh":"2026-07-17T09:00:00Z","claudeAiOauth":{"accessToken":"canonical-new"}}`)
			if applied, err := WriteAuthIfCurrentWithDigest(newer, strings.Repeat("b", 64), request.Generation); err != nil || applied {
				t.Fatalf("guarded newer response applied=%v err=%v", applied, err)
			}
			raw, err := os.ReadFile(path)
			if tc.wantMissing && errors.Is(err, os.ErrNotExist) {
				return
			}
			if err != nil || !strings.Contains(string(raw), tc.want) {
				t.Fatalf("guarded state changed: %q err=%v want=%q", raw, err, tc.want)
			}
		})
	}
}

func TestBlockedCanonicalWriteRejectsExactDefinitivelyInvalidGeneration(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"rejected"}}`)); err != nil {
		t.Fatal(err)
	}
	request, err := ReadAuthForRetrieveSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	canonical := json.RawMessage(`{"last_refresh":"2026-07-17T11:00:00Z","claudeAiOauth":{"accessToken":"canonical"}}`)
	if err := BlockedCanonicalWriteError(request, canonical, true); err == nil || !strings.Contains(err.Error(), "definitively rejected") {
		t.Fatalf("exact rejected generation error=%v", err)
	}
	if err := BlockedCanonicalWriteError(request, canonical, false); err == nil || !strings.Contains(err.Error(), "unchanged local generation") {
		t.Fatalf("unchanged blocked generation error=%v", err)
	}
	if err := os.WriteFile(request.Path, []byte(`{"claudeAiOauth":{"accessToken":"new-login"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := BlockedCanonicalWriteError(request, canonical, true); err != nil {
		t.Fatalf("different newer usable generation did not win: %v", err)
	}
}

func TestDifferentUsableLoginKeepsIntentUntilAcceptedUploadCAS(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"logged-out"}}`)); err != nil {
		t.Fatal(err)
	}
	before, err := ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	if marked, err := RecordExplicitLogout(before.Generation); err != nil || !marked {
		t.Fatalf("record logout=%v err=%v", marked, err)
	}
	if err := os.MkdirAll(filepath.Dir(before.Path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(before.Path, []byte(`{"claudeAiOauth":{"accessToken":"new-login"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	snap, intent, release, err := BeginAuthUploadState()
	if err != nil {
		t.Fatal(err)
	}
	release()
	if !intent.Exists || intent.Blocks(snap) || !snap.Usable || !strings.Contains(string(snap.Upload), "new-login") {
		t.Fatalf("new login upload state snap=%+v intent=%+v", snap, intent)
	}
	if !HasLogoutIntent() {
		t.Fatal("different usable login cleared logout intent before server acceptance")
	}
	if cleared, err := ClearLogoutIntentIfUnchanged(snap.Generation, intent); err != nil || !cleared {
		t.Fatalf("accepted upload marker CAS cleared=%v err=%v", cleared, err)
	}
	if HasLogoutIntent() {
		t.Fatal("server-acknowledged different login did not clear exact logout intent")
	}
}

func TestAcceptedCanonicalDigestIsReusedOnlyForMatchingNativeGeneration(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	wantCanonical := strings.Repeat("a", 64)
	payload := json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"accepted"}}`)
	applied, err := WriteAuthIfCurrentWithDigest(payload, wantCanonical, AuthGeneration{})
	if err != nil || !applied {
		t.Fatalf("initial canonical apply=%v err=%v", applied, err)
	}
	snap, err := ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	if got := snap.DigestForServer(); got != wantCanonical {
		t.Fatalf("server digest=%q want=%q", got, wantCanonical)
	}
	changed := []byte(`{"claudeAiOauth":{"accessToken":"local-login"}}`)
	if err := os.WriteFile(snap.Path, changed, 0o600); err != nil {
		t.Fatal(err)
	}
	changedSnap, err := ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	if changedSnap.DigestForServer() == wantCanonical || changedSnap.DigestForServer() != changedSnap.Generation.Digest {
		t.Fatalf("stale canonical digest leaked across native generation: %+v", changedSnap)
	}
}

func TestConcurrentWriteAuthKeepsNativeAndMirrorConsistent(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	clxDir := filepath.Join(home, ".clx", "auth")
	if err := os.MkdirAll(clxDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(clxDir, "credentials.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	payloads := []json.RawMessage{
		json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"one"}}`),
		json.RawMessage(`{"last_refresh":"2026-07-17T10:00:01Z","claudeAiOauth":{"accessToken":"two"}}`),
	}
	var wg sync.WaitGroup
	for _, payload := range payloads {
		payload := payload
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := WriteAuth(payload); err != nil {
				t.Errorf("WriteAuth: %v", err)
			}
		}()
	}
	wg.Wait()
	native, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
	if err != nil {
		t.Fatal(err)
	}
	mirror, err := os.ReadFile(filepath.Join(clxDir, "credentials.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(native) != string(mirror) {
		t.Fatalf("native/mirror split brain: native=%s mirror=%s", native, mirror)
	}
}

func TestServerAuthMayReplaceSharedPolicy(t *testing.T) {
	local := AuthSnapshot{
		Generation:  AuthGeneration{Exists: true, Digest: strings.Repeat("a", 64)},
		LastRefresh: time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC),
		Usable:      true,
	}
	older := json.RawMessage(`{"last_refresh":"2026-07-17T11:00:00Z","claudeAiOauth":{"accessToken":"canonical"}}`)
	newer := json.RawMessage(`{"last_refresh":"2026-07-17T13:00:00Z","claudeAiOauth":{"accessToken":"canonical"}}`)
	if ServerAuthMayReplace(local, older, "", "verified", false) {
		t.Fatal("older canonical replaced a usable newer local generation without definitive rejection")
	}
	if !ServerAuthMayReplace(local, newer, "", "verified", false) {
		t.Fatal("newer verified canonical was not allowed")
	}
	if !ServerAuthMayReplace(local, older, "", "verified", true) {
		t.Fatal("definitively rejected local candidate did not allow verified canonical healing")
	}
	if ServerAuthMayReplace(local, newer, "", "failed", true) {
		t.Fatal("verification_state=failed canonical was allowed")
	}
	local.Usable = false
	if !ServerAuthMayReplace(local, older, "", "verified", false) {
		t.Fatal("invalid local auth blocked verified canonical repair")
	}
}

func TestRetrieveSnapshotKeepsInvalidGenerationWithoutOfferingCandidate(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".claude", ".credentials.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{broken-json`), 0o600); err != nil {
		t.Fatal(err)
	}
	snap, err := ReadAuthForRetrieveSnapshot()
	if err != nil {
		t.Fatalf("retrieve snapshot rejected healable invalid JSON: %v", err)
	}
	if !snap.Generation.Exists || snap.Usable || len(snap.Upload) != 0 {
		t.Fatalf("invalid retrieve snapshot = %+v", snap)
	}
	if _, _, err := ReadAuthForUploadState(); err == nil {
		t.Fatal("explicit upload accepted invalid native JSON")
	}
}

// TestExtractAnthropicKey covers the four legacy credential shapes the
// wrapper accepts. Preserved from the bash extract_anthropic_key fragment.
func TestExtractAnthropicKey(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"api_key_flat", `{"api_key":"sk-abc"}`, "sk-abc"},
		{"anthropic_api_key", `{"anthropic_api_key":"sk-aap"}`, "sk-aap"},
		{"oauth_access_token", `{"claudeAiOauth":{"accessToken":"oat-1"}}`, "oat-1"},
		{"auths_map", `{"auths":{"api.anthropic.com":{"token":"tok-1"}}}`, "tok-1"},
		{"precedence_api_key_first", `{"api_key":"first","anthropic_api_key":"second"}`, "first"},
		{"empty_object", `{}`, ""},
		{"malformed_json", `{not-json`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := extractAnthropicKey([]byte(tc.raw)); got != tc.want {
				t.Errorf("extractAnthropicKey(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}
