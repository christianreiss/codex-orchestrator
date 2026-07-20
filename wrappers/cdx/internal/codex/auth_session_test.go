package codex

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ipc"
)

func TestAuthSessionFailsFastWhileMaintenanceOwnsExclusiveLease(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	maintenance, err := TryAcquireAuthMaintenance()
	if err != nil {
		t.Fatal(err)
	}
	defer maintenance.Release()
	started := time.Now()
	if session, err := AcquireAuthSession(); err == nil || session != nil {
		if session != nil {
			_, _, _ = FinishAuthSession(session)
		}
		t.Fatalf("shared auth session queued through maintenance: session=%v err=%v", session, err)
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("maintenance conflict blocked instead of failing fast: %s", elapsed)
	}
}

func TestStatusOnlyInsecureResponseWithoutHostRequestsPurge(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := AuthPath()
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"temporary"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	session, err := StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	if err := UpdateActiveAuthSessionSecurity("insecure-denied", nil); err != nil {
		t.Fatal(err)
	}
	removed, deferred, err := FinishAuthSession(session)
	if err != nil || !removed || deferred {
		t.Fatalf("status-only insecure cleanup = removed=%v deferred=%v err=%v", removed, deferred, err)
	}
}

func TestExplicitLogoutDefersAcrossPeerSessionBeforeChildStart(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	launched := filepath.Join(dir, "native-launched")
	bin := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\ntouch \"$CODEX_HOME/native-launched\"\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CDX_CODEX_BIN", bin)
	authPath, _ := AuthPath()
	if err := os.WriteFile(authPath, []byte(`{"tokens":{"access_token":"selected-by-peer"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	before, _ := CurrentAuthGeneration()
	peer, err := StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	exit, marked, deferred, err := RunExplicitLogout(context.Background(), &config.Config{Host: config.Host{Secure: true}}, []string{"logout"}, before)
	if err != nil || exit != 0 || !marked || !deferred {
		t.Fatalf("deferred logout = exit=%d marked=%v deferred=%v err=%v", exit, marked, deferred, err)
	}
	if _, err := os.Stat(launched); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("native logout launched while peer session had selected auth: %v", err)
	}
	if _, err := os.Stat(authPath); err != nil {
		t.Fatalf("deferred logout removed peer-selected auth too early: %v", err)
	}
	removed, stillDeferred, err := FinishAuthSession(peer)
	if err != nil || !removed || stillDeferred {
		t.Fatalf("last peer finish = removed=%v deferred=%v err=%v", removed, stillDeferred, err)
	}
	if active, err := LogoutIntentActive(); err != nil || !active {
		t.Fatalf("last peer erased explicit logout intent: active=%v err=%v", active, err)
	}
}

func TestExplicitLogoutJournalsBeforeNativeChildAndHandlesPartialFailure(t *testing.T) {
	for _, tc := range []struct {
		name          string
		script        string
		wantExit      int
		wantMarker    bool
		wantAuthExist bool
	}{
		{name: "success", script: "rm -f \"$CODEX_HOME/auth.json\"\nexit 0", wantExit: 0, wantMarker: true},
		{name: "failed unchanged rolls back", script: "exit 7", wantExit: 7, wantAuthExist: true},
		{name: "failed after removal keeps intent", script: "rm -f \"$CODEX_HOME/auth.json\"\nexit 7", wantExit: 7, wantMarker: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("CODEX_HOME", dir)
			bin := filepath.Join(t.TempDir(), "codex")
			if err := os.WriteFile(bin, []byte("#!/bin/sh\n"+tc.script+"\n"), 0o755); err != nil {
				t.Fatal(err)
			}
			t.Setenv("CDX_CODEX_BIN", bin)
			path, _ := AuthPath()
			if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"logout-me"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			before, _ := CurrentAuthGeneration()
			exit, marked, deferred, err := RunExplicitLogout(context.Background(), &config.Config{Host: config.Host{Secure: true}}, []string{"logout"}, before)
			if err != nil || exit != tc.wantExit || marked != tc.wantMarker || deferred {
				t.Fatalf("explicit logout = exit=%d marked=%v deferred=%v err=%v", exit, marked, deferred, err)
			}
			active, markerErr := LogoutIntentActive()
			if markerErr != nil || active != tc.wantMarker {
				t.Fatalf("logout marker active=%v err=%v, want %v", active, markerErr, tc.wantMarker)
			}
			_, statErr := os.Stat(path)
			if exists := statErr == nil; exists != tc.wantAuthExist {
				t.Fatalf("auth exists=%v err=%v, want %v", exists, statErr, tc.wantAuthExist)
			}
		})
	}
}

func TestExplicitLogoutMarkerFailurePreventsNativeChild(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	launched := filepath.Join(dir, "native-launched")
	bin := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\ntouch \"$CODEX_HOME/native-launched\"\nrm -f \"$CODEX_HOME/auth.json\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CDX_CODEX_BIN", bin)
	path, _ := AuthPath()
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"must-survive"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(logoutIntentPath(path), 0o700); err != nil {
		t.Fatal(err)
	}
	before, _ := CurrentAuthGeneration()
	exit, marked, _, err := RunExplicitLogout(context.Background(), &config.Config{Host: config.Host{Secure: true}}, []string{"logout"}, before)
	if err == nil || exit == 0 || marked {
		t.Fatalf("marker failure = exit=%d marked=%v err=%v", exit, marked, err)
	}
	if _, err := os.Stat(launched); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("native child launched before durable journal: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("marker failure lost auth: %v", err)
	}
}

func TestFinalSessionNeverImplicitlyClearsLogoutForDifferentUsableLogin(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path, _ := AuthPath()
	old := []byte(`{"last_refresh":"2026-07-17T09:00:00Z","tokens":{"access_token":"old"}}`)
	if err := os.WriteFile(path, old, 0o600); err != nil {
		t.Fatal(err)
	}
	oldGeneration, _ := CurrentAuthGeneration()
	if marked, err := MarkLogoutIntent(oldGeneration); err != nil || !marked {
		t.Fatalf("mark logout = %v, %v", marked, err)
	}
	newLogin := []byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"new-login"}}`)
	if err := os.WriteFile(path, newLogin, 0o600); err != nil {
		t.Fatal(err)
	}
	session, err := StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	removed, deferred, err := FinishAuthSession(session)
	if err != nil || removed || deferred {
		t.Fatalf("final cleanup = removed=%v deferred=%v err=%v", removed, deferred, err)
	}
	if raw, err := os.ReadFile(path); err != nil || string(raw) != string(newLogin) {
		t.Fatalf("unaccepted new login changed by final cleanup: %q, %v", raw, err)
	}
	if active, err := LogoutIntentActive(); err != nil || !active {
		t.Fatalf("final cleanup implicitly cleared logout: active=%v err=%v", active, err)
	}
}

func TestAuthSessionLeaseIsKeyedToEffectiveCodexHome(t *testing.T) {
	homeA := t.TempDir()
	homeB := t.TempDir()
	t.Setenv("CODEX_HOME", homeA)
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	shared, err := AcquireAuthSession()
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _, _ = FinishAuthSession(shared)
	}()

	// A different runtime namespace must not split coordination for one home.
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	if exclusive, err := TryAcquireAuthMaintenance(); !errors.Is(err, ipc.ErrHeld) {
		if exclusive != nil {
			_ = exclusive.Release()
		}
		t.Fatalf("same Codex home escaped lease through XDG_RUNTIME_DIR: %v", err)
	}

	// A genuinely different Codex home is a different auth resource.
	t.Setenv("CODEX_HOME", homeB)
	exclusive, err := TryAcquireAuthMaintenance()
	if err != nil {
		t.Fatalf("different Codex home was spuriously blocked: %v", err)
	}
	if err := exclusive.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestReexecHandoffBridgesLeaseAndPurgesOnRestartedExit(t *testing.T) {
	const stageKey = "CDX_REEXEC_HANDOFF_TEST_STAGE"
	switch os.Getenv(stageKey) {
	case "prepare":
		authPath, err := AuthPath()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(authPath, []byte(`{"tokens":{"access_token":"temporary"}}`), 0o600); err != nil {
			t.Fatal(err)
		}
		session, err := StartAuthSession(true)
		if err != nil {
			t.Fatal(err)
		}
		env, cancel, err := PrepareAuthSessionReexec(os.Environ())
		if err != nil {
			_, _, _ = FinishAuthSession(session)
			t.Fatal(err)
		}
		env = replaceEnvForTest(env, stageKey, "resume")
		if err := syscall.Exec(os.Args[0], []string{os.Args[0], "-test.run=^TestReexecHandoffBridgesLeaseAndPurgesOnRestartedExit$"}, env); err != nil {
			_ = cancel()
			_, _, _ = FinishAuthSession(session)
			t.Fatal(err)
		}
	case "resume":
		if maintenance, err := TryAcquireAuthMaintenance(); !errors.Is(err, ipc.ErrHeld) {
			if maintenance != nil {
				_ = maintenance.Release()
			}
			t.Fatalf("inherited bridge did not cover pre-adoption gap: %v", err)
		}
		session, err := ResumeAuthSessionReexecHandoff()
		if err != nil || session == nil {
			t.Fatalf("resume handoff = session=%v err=%v", session, err)
		}
		if maintenance, err := TryAcquireAuthMaintenance(); !errors.Is(err, ipc.ErrHeld) {
			if maintenance != nil {
				_ = maintenance.Release()
			}
			t.Fatalf("replacement session did not take over bridge: %v", err)
		}
		removed, deferred, err := FinishAuthSession(session)
		if err != nil || !removed || deferred {
			t.Fatalf("restarted finish = removed=%v deferred=%v err=%v", removed, deferred, err)
		}
		authPath, _ := AuthPath()
		if _, err := os.Stat(authPath); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("restarted exit stranded insecure auth: %v", err)
		}
		maintenance, err := TryAcquireAuthMaintenance()
		if err != nil {
			t.Fatalf("replacement lease survived restarted exit: %v", err)
		}
		_ = maintenance.Release()
	default:
		dir := t.TempDir()
		cmd := exec.Command(os.Args[0], "-test.run=^TestReexecHandoffBridgesLeaseAndPurgesOnRestartedExit$")
		cmd.Env = replaceEnvForTest(os.Environ(), "CODEX_HOME", dir)
		cmd.Env = replaceEnvForTest(cmd.Env, stageKey, "prepare")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("handoff subprocess: %v\n%s", err, output)
		}
		if _, err := os.Stat(filepath.Join(dir, "auth.json")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("handoff subprocess left auth behind: %v", err)
		}
	}
}

func replaceEnvForTest(env []string, key, value string) []string {
	prefix := key + "="
	out := append([]string(nil), env...)
	for i, entry := range out {
		if strings.HasPrefix(entry, prefix) {
			out[i] = prefix + value
			return out
		}
	}
	return append(out, prefix+value)
}

func TestPersistedPurgeRequestReachesStaleSecureOuterSession(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"temporary"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	outer, err := StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	inner, err := StartAuthSession(false)
	if err != nil {
		_, _, _ = FinishAuthSession(outer)
		t.Fatal(err)
	}
	if err := SetActiveAuthSessionsPurgeOnLastExit(true); err != nil {
		t.Fatal(err)
	}
	removed, deferred, err := FinishAuthSession(inner)
	if err != nil || removed || !deferred {
		t.Fatalf("inner finish = removed=%v deferred=%v err=%v", removed, deferred, err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("inner session purged while outer remained: %v", err)
	}
	removed, deferred, err = FinishAuthSession(outer)
	if err != nil || !removed || deferred {
		t.Fatalf("stale-secure outer finish = removed=%v deferred=%v err=%v", removed, deferred, err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("persisted purge request was lost: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, authPurgeRequestFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("completed purge request remains: %v", err)
	}
}

func TestSoleSessionCancelsStaleInsecureConfigAfterSecureResponse(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"keep"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	session, err := StartAuthSession(true)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetActiveAuthSessionsPurgeOnLastExit(false); err != nil {
		t.Fatal(err)
	}
	removed, deferred, err := FinishAuthSession(session)
	if err != nil || removed || deferred {
		t.Fatalf("secure response finish = removed=%v deferred=%v err=%v", removed, deferred, err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("secure live response did not cancel stale purge: %v", err)
	}
}

func TestSecureSessionCannotCancelConcurrentInsecureSessionRequest(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"temporary"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	first, err := StartAuthSession(true)
	if err != nil {
		t.Fatal(err)
	}
	second, err := AcquireAuthSession()
	if err != nil {
		t.Fatal(err)
	}
	if err := second.SetPurgeOnLastExit(false); err != nil {
		t.Fatal(err)
	}
	if removed, deferred, err := FinishAuthSession(second); err != nil || removed || !deferred {
		t.Fatalf("secure peer finish = removed=%v deferred=%v err=%v", removed, deferred, err)
	}
	if removed, deferred, err := FinishAuthSession(first); err != nil || !removed || deferred {
		t.Fatalf("insecure owner finish = removed=%v deferred=%v err=%v", removed, deferred, err)
	}
}

func TestActiveChildLeaseAllowsGuardedCanonicalButBlocksDestructiveMutation(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	path := filepath.Join(dir, "auth.json")
	original := []byte(`{"tokens":{"access_token":"child-owned"}}`)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	expected, err := CurrentAuthGeneration()
	if err != nil {
		t.Fatal(err)
	}
	child, err := AcquireActiveChild()
	if err != nil {
		t.Fatal(err)
	}

	server := json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"server"}}`)
	if wrote, err := WriteAuthIfCurrent(server, expected); err != nil || !wrote {
		t.Fatalf("guarded write during child = %v, %v", wrote, err)
	}
	if err := WriteAuth(server); !errors.Is(err, ErrActiveChild) {
		t.Fatalf("unconditional write during child = %v", err)
	}
	payload, generation, err := ReadAuthForUpload()
	if err != nil {
		t.Fatal(err)
	}
	if generation == expected {
		t.Fatalf("canonical materialization did not advance generation during child: %+v", generation)
	}
	if string(payload) == string(original) {
		t.Fatal("upload payload was not deterministically stabilized in memory")
	}
	if removed, err := RemoveAuthIfCurrent(expected); err != nil || removed {
		t.Fatalf("remove during child = %v, %v", removed, err)
	}
	if raw, err := os.ReadFile(path); err != nil || !strings.Contains(string(raw), "server") {
		t.Fatalf("canonical file missing: %q, %v", raw, err)
	}
	if err := child.Release(); err != nil {
		t.Fatal(err)
	}
	current, _ := CurrentAuthGeneration()
	if wrote, err := WriteAuthIfCurrent(json.RawMessage(`{"last_refresh":"2026-07-17T11:00:00Z","tokens":{"access_token":"server-2"}}`), current); err != nil || !wrote {
		t.Fatalf("write after child = %v, %v", wrote, err)
	}
}
