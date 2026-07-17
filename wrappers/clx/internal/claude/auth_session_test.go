package claude

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
)

func TestInsecureAuthPurgesOnlyAfterLastSharedSession(t *testing.T) {
	for _, tc := range []struct {
		name       string
		firstClose int
	}{
		{name: "owner exits first", firstClose: 0},
		{name: "secondary exits first", firstClose: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			clxDir := filepath.Join(home, ".clx", "auth")
			if err := os.MkdirAll(clxDir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(clxDir, "credentials.json"), []byte(`{}`), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"secret"}}`)); err != nil {
				t.Fatal(err)
			}
			sessions := make([]*AuthSession, 2)
			for i := range sessions {
				var err error
				sessions[i], err = StartAuthSession(i == 0)
				if err != nil {
					t.Fatal(err)
				}
			}
			purged, err := sessions[tc.firstClose].CloseAndPurgeIfLast()
			if err != nil || purged {
				t.Fatalf("first exit purged=%v err=%v", purged, err)
			}
			if _, err := os.Stat(filepath.Join(home, ".claude", ".credentials.json")); err != nil {
				t.Fatalf("first exit removed credentials used by peer: %v", err)
			}
			last := 1 - tc.firstClose
			purged, err = sessions[last].CloseAndPurgeIfLast()
			if err != nil || !purged {
				t.Fatalf("last exit purged=%v err=%v", purged, err)
			}
			for _, path := range []string{
				filepath.Join(home, ".claude", ".credentials.json"),
				filepath.Join(home, ".clx", "auth", "credentials.json"),
				filepath.Join(home, ".clx", "auth", generationStateFile),
			} {
				if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("credential artifact survived last exit: %s err=%v", path, err)
				}
			}
		})
	}
}

func TestPurgeCancellationIsScopedToOneSessionRequest(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"temporary"}}`)); err != nil {
		t.Fatal(err)
	}
	first, err := StartAuthSession(true)
	if err != nil {
		t.Fatal(err)
	}
	second, err := StartAuthSession(true)
	if err != nil {
		t.Fatal(err)
	}
	if err := second.SetPurgeOnLastExit(false); err != nil {
		t.Fatal(err)
	}
	if purged, err := second.CloseAndPurgeIfLast(); err != nil || purged {
		t.Fatalf("second close purged=%v err=%v", purged, err)
	}
	if purged, err := first.CloseAndPurgeIfLast(); err != nil || !purged {
		t.Fatalf("first insecure request lost: purged=%v err=%v", purged, err)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", ".credentials.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("credentials survived outstanding insecure request: %v", err)
	}
}

func TestSoleSessionCanCancelStaleConfigPurgeRequest(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"keep"}}`)); err != nil {
		t.Fatal(err)
	}
	session, err := StartAuthSession(true)
	if err != nil {
		t.Fatal(err)
	}
	if err := session.SetPurgeOnLastExit(false); err != nil {
		t.Fatal(err)
	}
	if purged, err := session.CloseAndPurgeIfLast(); err != nil || purged {
		t.Fatalf("cancelled session purged=%v err=%v", purged, err)
	}
	if !HasUsableAuth() {
		t.Fatal("secure API cancellation lost native credentials")
	}
}

func TestLogoutIntentBlocksSidecarAndCanonicalResurrection(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	payload := json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"old"}}`)
	if err := WriteAuth(payload); err != nil {
		t.Fatal(err)
	}
	before, err := ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(before.Path); err != nil {
		t.Fatal(err)
	}
	marked, err := MarkLogoutIfCurrent(before.Generation)
	if err != nil || !marked {
		t.Fatalf("MarkLogoutIfCurrent marked=%v err=%v", marked, err)
	}
	if HasUsableAuth() {
		t.Fatal("sidecar resurrected native logout")
	}
	applied, err := WriteAuthIfCurrent(payload, AuthGeneration{})
	if err != nil {
		t.Fatal(err)
	}
	if applied {
		t.Fatal("server canonical resurrected a recorded local logout")
	}
	session, err := StartAuthSession(true)
	if err != nil {
		t.Fatal(err)
	}
	purged, err := session.CloseAndPurgeIfLast()
	if err != nil || !purged {
		t.Fatalf("insecure last-session purge=%v err=%v", purged, err)
	}
	if !HasLogoutIntent() {
		t.Fatal("insecure purge erased explicit logout intent")
	}
	applied, err = WriteAuthIfCurrent(payload, AuthGeneration{})
	if err != nil || applied {
		t.Fatalf("canonical resurrected logout after insecure purge: applied=%v err=%v", applied, err)
	}
	if _, err := os.Stat(before.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("native credentials reappeared: %v", err)
	}
}

func TestExplicitLoginClearsLogoutIntentForIdenticalCredentialDigest(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	payload := json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"same"}}`)
	if err := WriteAuth(payload); err != nil {
		t.Fatal(err)
	}
	before, err := ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	raw := append([]byte(nil), before.Raw...)
	if err := os.Remove(before.Path); err != nil {
		t.Fatal(err)
	}
	marked, err := MarkLogoutIfCurrent(before.Generation)
	if err != nil || !marked {
		t.Fatalf("mark logout=%v err=%v", marked, err)
	}
	if err := os.WriteFile(before.Path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if !HasLogoutIntent() {
		t.Fatal("identical digest unexpectedly cleared logout intent without explicit login")
	}
	login, intent, err := ReadAuthForUploadState()
	if err != nil {
		t.Fatal(err)
	}
	if cleared, err := ClearLogoutIntentIfUnchanged(login.Generation, intent); err != nil || !cleared {
		t.Fatalf("same-digest login marker CAS cleared=%v err=%v", cleared, err)
	}
	if HasLogoutIntent() {
		t.Fatal("explicit login did not clear digest-identical logout intent")
	}
	current, err := ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	applied, err := WriteAuthIfCurrent(payload, current.Generation)
	if err != nil || !applied {
		t.Fatalf("accepted explicit login not writable: applied=%v err=%v", applied, err)
	}
}

func TestExplicitLogoutWithoutPriorNativeAuthStillBlocksCanonicalResurrection(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	payload := json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"server-copy"}}`)
	marked, err := RecordExplicitLogout(AuthGeneration{})
	if err != nil || !marked {
		t.Fatalf("RecordExplicitLogout marked=%v err=%v", marked, err)
	}
	if !HasLogoutIntent() {
		t.Fatal("explicit logout from a missing native file was not recorded")
	}
	applied, err := WriteAuthIfCurrent(payload, AuthGeneration{})
	if err != nil || applied {
		t.Fatalf("canonical resurrected explicit missing-file logout: applied=%v err=%v", applied, err)
	}
}

func TestAuthMaintenanceRefusesActiveSharedSession(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	session, err := StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	if maintenance, err := AcquireAuthMaintenance(); !errors.Is(err, ErrAuthSessionsActive) || maintenance != nil {
		t.Fatalf("maintenance with active session = (%v,%v)", maintenance, err)
	}
	if _, err := session.CloseAndPurgeIfLast(); err != nil {
		t.Fatal(err)
	}
	maintenance, err := AcquireAuthMaintenance()
	if err != nil {
		t.Fatal(err)
	}
	if err := maintenance.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestExplicitLogoutSessionDefersAcrossPeerWithoutChild(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"shared"}}`)); err != nil {
		t.Fatal(err)
	}
	before, err := ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	peer, err := StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	logout, peers, err := StartExplicitLogoutSession(false)
	if err != nil || !peers {
		t.Fatalf("explicit logout session = (%v, peers=%v, %v)", logout, peers, err)
	}
	marked, err := RecordDeferredExplicitLogout(before.Generation)
	if err != nil || !marked {
		t.Fatalf("deferred logout marker = %v, %v", marked, err)
	}
	if _, err := os.Stat(before.Path); err != nil {
		t.Fatalf("deferred logout removed auth before peer child launch: %v", err)
	}
	if purged, err := logout.CloseAndPurgeIfLast(); err != nil || purged {
		t.Fatalf("logout close with peer purged=%v err=%v", purged, err)
	}
	if _, err := os.Stat(before.Path); err != nil {
		t.Fatalf("logout close removed auth still selected by peer: %v", err)
	}
	if purged, err := peer.CloseAndPurgeIfLast(); err != nil || purged {
		t.Fatalf("secure peer finalization purged=%v err=%v", purged, err)
	}
	if _, err := os.Stat(before.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("last peer did not complete deferred logout: %v", err)
	}
}

func TestNewAuthSessionFailsWhileMaintenanceIsActive(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	maintenance, err := AcquireAuthMaintenance()
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	session, err := StartAuthSession(false)
	if session != nil || !errors.Is(err, ErrAuthMaintenanceActive) {
		t.Fatalf("session during maintenance = (%v,%v)", session, err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("session acquisition blocked behind maintenance instead of failing closed")
	}
	if err := maintenance.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAuthMaintenanceRefusesActiveChildWithoutSessionLease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	child, err := acquireAuthChildShared()
	if err != nil {
		t.Fatal(err)
	}
	if maintenance, err := AcquireAuthMaintenance(); !errors.Is(err, ErrAuthChildActive) || maintenance != nil {
		t.Fatalf("maintenance with active child = (%v,%v)", maintenance, err)
	}
	if err := child.Close(); err != nil {
		t.Fatal(err)
	}
	maintenance, err := AcquireAuthMaintenance()
	if err != nil {
		t.Fatal(err)
	}
	if err := maintenance.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAuthLeasesSurviveKilledWrapperWhileNativeChildLives(t *testing.T) {
	if os.Getenv("CLX_KILL_PARENT_HELPER") == "1" {
		session, err := StartAuthSession(true)
		if err != nil {
			os.Exit(2)
		}
		exit, _, err := RunCaptureWithAuthSession(context.Background(), &config.Config{}, nil, session)
		if err != nil || exit != 0 {
			os.Exit(3)
		}
		os.Exit(0)
	}

	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"in-use"}}`)); err != nil {
		t.Fatal(err)
	}
	request, err := ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	ready := filepath.Join(home, "native-ready")
	release := filepath.Join(home, "native-release")
	pidPath := filepath.Join(home, "native-pid")
	bin := filepath.Join(t.TempDir(), "claude")
	script := `#!/bin/sh
echo $$ > "$CLX_NATIVE_PID"
: > "$CLX_NATIVE_READY"
while [ ! -e "$CLX_NATIVE_RELEASE" ]; do sleep 0.01; done
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestAuthLeasesSurviveKilledWrapperWhileNativeChildLives$")
	cmd.Env = append(os.Environ(),
		"HOME="+home,
		"CLX_KILL_PARENT_HELPER=1",
		"CLX_CLAUDE_BIN="+bin,
		"CLX_NATIVE_READY="+ready,
		"CLX_NATIVE_RELEASE="+release,
		"CLX_NATIVE_PID="+pidPath,
	)
	devNull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = devNull.Close() })
	cmd.Stdout = devNull
	cmd.Stderr = devNull
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.WriteFile(release, nil, 0o600) })
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			t.Fatal("native helper did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	pidRaw, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	childPID, err := strconv.Atoi(strings.TrimSpace(string(pidRaw)))
	if err != nil || syscall.Kill(childPID, 0) != nil {
		t.Fatalf("native child did not survive wrapper SIGKILL: pid=%d parse=%v", childPID, err)
	}
	if maintenance, err := AcquireAuthMaintenance(); !errors.Is(err, ErrAuthSessionsActive) || maintenance != nil {
		t.Fatalf("killed wrapper dropped inherited session lease: maintenance=%v err=%v", maintenance, err)
	}
	applied, err := WriteAuthIfCurrent(json.RawMessage(`{"last_refresh":"2026-07-17T11:00:00Z","claudeAiOauth":{"accessToken":"replacement"}}`), request.Generation)
	if err != nil || applied {
		t.Fatalf("canonical write crossed orphaned native child: applied=%v err=%v", applied, err)
	}
	observer, err := StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	if purged, err := observer.CloseAndPurgeIfLast(); err != nil || purged {
		t.Fatalf("observer purged under orphaned child: purged=%v err=%v", purged, err)
	}
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for {
		maintenance, err := AcquireAuthMaintenance()
		if err == nil {
			if err := maintenance.Close(); err != nil {
				t.Fatal(err)
			}
			break
		}
		if !errors.Is(err, ErrAuthSessionsActive) && !errors.Is(err, ErrAuthChildActive) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("inherited leases remained after native child exit")
		}
		time.Sleep(10 * time.Millisecond)
	}
	finalizer, err := StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	if purged, err := finalizer.CloseAndPurgeIfLast(); err != nil || !purged {
		t.Fatalf("orphaned insecure request not serviced: purged=%v err=%v", purged, err)
	}
	if HasUsableAuth() {
		t.Fatal("credentials survived final cleanup after orphaned child exit")
	}
}

func TestExplicitLogoutDuringPeerChildRecordsUniqueIntentAndDefersNativeRemoval(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	payload := json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"shared"}}`)
	if err := WriteAuth(payload); err != nil {
		t.Fatal(err)
	}
	before, err := ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	peerSession, err := StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	child, err := acquireAuthChildShared()
	if err != nil {
		t.Fatal(err)
	}
	marked, err := RecordExplicitLogout(before.Generation)
	if err != nil || !marked {
		t.Fatalf("logout with peer child marked=%v err=%v", marked, err)
	}
	paths, err := authFiles()
	if err != nil {
		t.Fatal(err)
	}
	firstMarker, err := os.ReadFile(paths.logout)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(before.Path); err != nil {
		t.Fatalf("native auth was removed while peer child was active: %v", err)
	}
	marked, err = RecordExplicitLogout(before.Generation)
	if err != nil || !marked {
		t.Fatalf("second logout with peer child marked=%v err=%v", marked, err)
	}
	secondMarker, err := os.ReadFile(paths.logout)
	if err != nil {
		t.Fatal(err)
	}
	if string(firstMarker) == string(secondMarker) {
		t.Fatal("same-generation logout markers reused identical bytes; nonce CAS is unsafe")
	}
	if active, err := LogoutIntentActive(); err != nil || !active {
		t.Fatalf("logout intent with active child = %v, %v", active, err)
	}
	if err := child.Close(); err != nil {
		t.Fatal(err)
	}
	if purged, err := peerSession.CloseAndPurgeIfLast(); err != nil || purged {
		t.Fatalf("secure peer finalization purged=%v err=%v", purged, err)
	}
	if _, err := os.Stat(before.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("peer exit did not automatically complete deferred native removal: %v", err)
	}
	if active, err := LogoutIntentActive(); err != nil || !active {
		t.Fatalf("deferred logout marker after peer exit = %v, %v", active, err)
	}
}

func TestRecordExplicitLogoutJournalsBeforeNativeRemoval(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	payload := json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"keep-on-marker-failure"}}`)
	if err := WriteAuth(payload); err != nil {
		t.Fatal(err)
	}
	before, err := ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := authFiles()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(paths.logout, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(paths.logout, "block-rename"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if marked, err := RecordExplicitLogout(before.Generation); err == nil || marked {
		t.Fatalf("logout marker failure = marked %v err %v", marked, err)
	}
	if _, err := os.Stat(before.Path); err != nil {
		t.Fatalf("native auth was removed before durable marker commit: %v", err)
	}
}

func TestFailedExplicitLogoutRestoresPreexistingIntent(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"same"}}`)); err != nil {
		t.Fatal(err)
	}
	before, err := ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	if marked, err := RecordDeferredExplicitLogout(before.Generation); err != nil || !marked {
		t.Fatalf("seed intent=%v err=%v", marked, err)
	}
	paths, err := authFiles()
	if err != nil {
		t.Fatal(err)
	}
	previous, err := os.ReadFile(paths.logout)
	if err != nil {
		t.Fatal(err)
	}
	guard, deferred, marked, err := beginExplicitLogout(before.Generation)
	if err != nil || guard == nil || deferred || !marked {
		t.Fatalf("begin logout guard=%v deferred=%v marked=%v err=%v", guard, deferred, marked, err)
	}
	if marked, err := guard.finish(false); err != nil || marked {
		t.Fatalf("failed logout finish marked=%v err=%v", marked, err)
	}
	after, err := os.ReadFile(paths.logout)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(previous) {
		t.Fatal("failed logout erased or replaced preexisting intent")
	}
}

func TestFinalizeForReexecConsumesSoleInsecureRequest(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"temporary"}}`)); err != nil {
		t.Fatal(err)
	}
	session, err := StartAuthSession(true)
	if err != nil {
		t.Fatal(err)
	}
	if err := session.FinalizeForReexec(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", ".credentials.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("re-exec finalization left insecure credentials: %v", err)
	}
	paths, err := authFiles()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(paths.purgeRequest); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("re-exec finalization orphaned purge request: %v", err)
	}
	if _, err := session.CloseAndPurgeIfLast(); err != nil {
		t.Fatalf("ordinary defer after re-exec finalization is not idempotent: %v", err)
	}
}

func TestExplicitLogoutPreservesDifferentUsableConcurrentLogin(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"before"}}`)); err != nil {
		t.Fatal(err)
	}
	before, err := ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	newLogin := []byte(`{"claudeAiOauth":{"accessToken":"newer-login"}}`)
	if err := os.WriteFile(before.Path, newLogin, 0o600); err != nil {
		t.Fatal(err)
	}
	marked, err := RecordExplicitLogout(before.Generation)
	if err != nil || marked {
		t.Fatalf("logout over newer login marked=%v err=%v", marked, err)
	}
	raw, err := os.ReadFile(before.Path)
	if err != nil || string(raw) != string(newLogin) {
		t.Fatalf("newer concurrent login was not preserved: raw=%q err=%v", raw, err)
	}
	if intent, err := CurrentLogoutIntentGeneration(); err != nil || intent.Exists {
		t.Fatalf("logout marker survived newer login: intent=%+v err=%v", intent, err)
	}
}
