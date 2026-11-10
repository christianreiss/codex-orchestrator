package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claudeconfiglock"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

func testSettingsPartial() *orchestrator.ClaudeSettings {
	return &orchestrator.ClaudeSettings{Status: "updated", Partial: json.RawMessage(`{"model":"sonnet"}`), OwnedPaths: []string{"model"}}
}

func TestSettingsReadFollowsMCPWaitAndPreservesIndependentSave(t *testing.T) {
	testSettingsSaveDuringMCPWait(t, "")
}

func TestSettingsReadPreservesActualNativePluginDisable(t *testing.T) {
	binary := os.Getenv("CLAUDE_NATIVE_TEST_BIN")
	if binary == "" {
		t.Skip("set CLAUDE_NATIVE_TEST_BIN to run the real native save regression")
	}
	testSettingsSaveDuringMCPWait(t, binary)
}

func testSettingsSaveDuringMCPWait(t *testing.T, binary string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o700); err != nil {
		t.Fatal(err)
	}
	path := settingsPath()
	if err := os.WriteFile(path, []byte(`{"theme":"dark","enabledPlugins":{"research-test@research":true}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	lockDir := holdNativeLock(t, 0)
	before := userConfigLockOptions
	t.Cleanup(func() { userConfigLockOptions = before })
	saved := false
	userConfigLockOptions = claudeconfiglock.Options{Budget: time.Second, Sleep: func(_ time.Duration) {
		if saved {
			return
		}
		saved = true
		if binary == "" {
			if err := atomicWrite(path, []byte(`{"theme":"light","language":"German","enabledPlugins":{"research-test@research":false}}`), 0o600); err != nil {
				t.Fatal(err)
			}
		} else {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, binary, "plugin", "disable", "research-test@research", "--scope", "user")
			cmd.Dir = home
			cmd.Env = []string{"HOME=" + home, "CLAUDE_CONFIG_DIR=" + filepath.Join(home, ".claude"), "PATH=" + os.Getenv("PATH"), "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", "DISABLE_AUTOUPDATER=1", "DISABLE_UPDATES=1", "CLAUDE_CODE_DISABLE_FEATURE_FLAGS=1"}
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("native save: %v %s", err, out)
			}
			if parseObj(t, readFile(t, path))["enabledPlugins"].(map[string]any)["research-test@research"] != false {
				t.Fatal("native disable did not change the isolated settings")
			}
		}
		if err := os.Remove(lockDir); err != nil {
			t.Fatal(err)
		}
	}}
	cs := &orchestrator.ClaudeSettings{Status: "updated", Partial: json.RawMessage(`{"model":"sonnet","mcpServers":{"clx":{"command":"fleet"}}}`), OwnedPaths: []string{"model", "mcpServers.clx"}}
	if changed, err := applyManagedSettingsResult(cs, slog.Default()); !changed || err != nil {
		t.Fatalf("apply = %v %v", changed, err)
	}
	got := parseObj(t, readFile(t, path))
	if !saved || got["model"] != "sonnet" || got["enabledPlugins"].(map[string]any)["research-test@research"] != false {
		t.Fatalf("native/local save lost: %v", got)
	}
	if binary == "" && (got["theme"] != "light" || got["language"] != "German") {
		t.Fatalf("local edit/addition lost: %v", got)
	}
}

func TestDetectedNativeSaveRebasesOwnershipAndPreservesNewLocalLeaves(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := os.MkdirAll(filepath.Dir(settingsPath()), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settingsPath(), []byte(`{"theme":"dark","env":{"OLD":"fleet","LOCAL":"keep"}}`), 0o640); err != nil {
		t.Fatal(err)
	}
	prev := managedState{Version: 1, KeyPaths: []string{"env.OLD"}, PermissionRules: map[string][]string{}}
	if err := saveManagedState(prev); err != nil {
		t.Fatal(err)
	}
	calls := 0
	publish := func(path string, body []byte, snapshot settingsSnapshot) error {
		calls++
		if calls == 1 {
			if err := atomicWrite(path, []byte(`{"theme":"light","language":"German","env":{"OLD":"fleet","LOCAL":"changed","NEW":"native"}}`), 0o640); err != nil {
				return err
			}
		}
		return publishSettingsSnapshot(path, body, snapshot)
	}
	if _, err := applyManagedSettingsWithPublisher(testSettingsPartial(), slog.Default(), publish); err != nil {
		t.Fatal(err)
	}
	got := parseObj(t, readFile(t, settingsPath()))
	env := got["env"].(map[string]any)
	if calls != 2 || got["theme"] != "light" || got["language"] != "German" || env["LOCAL"] != "changed" || env["NEW"] != "native" || env["OLD"] != nil {
		t.Fatalf("rebase/withdrawal lost values: %v calls=%d", got, calls)
	}
	info, _ := os.Stat(settingsPath())
	if info.Mode().Perm() != 0o640 {
		t.Fatalf("mode changed: %v", info.Mode())
	}
	if !bytesEqual(readFile(t, settingsPath()), readFile(t, filepath.Join(os.Getenv("HOME"), ".clx", "config", "settings.json"))) {
		t.Fatal("mirror differs from successful merge")
	}
}

func TestDetectedContentionDoesNotAdvanceMirrorOrOwnership(t *testing.T) {
	for _, malformed := range []bool{false, true} {
		t.Run(fmt.Sprint(malformed), func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			cs := testSettingsPartial()
			if _, err := applyManagedSettingsResult(cs, slog.Default()); err != nil {
				t.Fatal(err)
			}
			state := readFile(t, managedStatePath())
			mirror := filepath.Join(os.Getenv("HOME"), ".clx", "config", "settings.json")
			mirrorBefore := readFile(t, mirror)
			cs.Partial = json.RawMessage(`{"language":"German"}`)
			cs.OwnedPaths = []string{"language"}
			calls := 0
			var latest []byte
			publish := func(path string, body []byte, snapshot settingsSnapshot) error {
				calls++
				latest = []byte(fmt.Sprintf(`{"model":"sonnet","native":%d}`, calls))
				if malformed {
					latest = []byte("{ // native JSONC\n}")
				}
				if err := atomicWrite(path, latest, 0o600); err != nil {
					return err
				}
				return publishSettingsSnapshot(path, body, snapshot)
			}
			changed, err := applyManagedSettingsWithPublisher(cs, slog.Default(), publish)
			if changed || err == nil {
				t.Fatalf("uncertain merge = %v %v", changed, err)
			}
			if !malformed && (!errors.Is(err, ErrUserSettingsChanged) || calls != 3) {
				t.Fatalf("unbounded/unreported contention: calls=%d err=%v", calls, err)
			}
			if malformed && !errors.Is(err, ErrUserSettingsUnparseable) {
				t.Fatalf("malformed re-read accepted: %v", err)
			}
			if !bytesEqual(latest, readFile(t, settingsPath())) || !bytesEqual(state, readFile(t, managedStatePath())) || !bytesEqual(mirrorBefore, readFile(t, mirror)) {
				t.Fatal("deferred merge changed native file, mirror or ownership")
			}
		})
	}
}

func TestWrapperSettingsLockDefersApplyAndStripWithoutSideEffects(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if _, err := applyManagedSettingsResult(testSettingsPartial(), slog.Default()); err != nil {
		t.Fatal(err)
	}
	before := map[string][]byte{}
	for _, path := range []string{settingsPath(), managedStatePath(), filepath.Join(os.Getenv("HOME"), ".clx", "config", "settings.json")} {
		before[path] = readFile(t, path)
	}
	lock, err := acquireSettingsMutationLock()
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := applyManagedSettingsResult(testSettingsPartial(), slog.Default()); done <- err }()
	if err := <-done; !errors.Is(err, ErrManagedSettingsLocked) {
		t.Fatalf("contender acquired lock: %v", err)
	}
	if err := stripManagedSettings(slog.Default()); !errors.Is(err, ErrManagedSettingsLocked) {
		t.Fatalf("strip acquired lock: %v", err)
	}
	for path, raw := range before {
		if !bytesEqual(raw, readFile(t, path)) {
			t.Fatalf("locked mutation changed %s", path)
		}
	}
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
	if err := stripManagedSettings(slog.Default()); err != nil {
		t.Fatal(err)
	}
	if len(loadManagedState().KeyPaths) != 0 {
		t.Fatal("released retry did not withdraw ownership")
	}
}

func TestSettingsSnapshotDetectsSameBytesReplacementAndAbsentEmptyFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	absent, err := readSettingsSnapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := publishSettingsSnapshot(path, []byte("{}"), absent); !errors.Is(err, ErrUserSettingsChanged) {
		t.Fatalf("absent and empty confused: %v", err)
	}
	if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := readSettingsSnapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := atomicWrite(path, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := publishSettingsSnapshot(path, []byte(`{"model":"sonnet"}`), snapshot); !errors.Is(err, ErrUserSettingsChanged) {
		t.Fatalf("inode replacement was not detected: %v", err)
	}
	if string(readFile(t, path)) != "{}" {
		t.Fatal("conflict overwrote user file")
	}
	staged, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".settings-merge-*"))
	if len(staged) != 0 {
		t.Fatalf("conflicts left staged files: %v", staged)
	}
}

func TestSettingsStripRebasesDetectedLocalChangeBeforeClearingOwnership(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if _, err := applyManagedSettingsResult(testSettingsPartial(), slog.Default()); err != nil {
		t.Fatal(err)
	}
	changed := false
	err := stripManagedSettingsWith(slog.Default(), func(path string, body []byte, mode os.FileMode) error {
		if path == settingsPath() && !changed {
			changed = true
			if err := atomicWrite(path, []byte(`{"model":"sonnet","theme":"light","local":{"literal.key":true}}`), mode); err != nil {
				return err
			}
			return ErrUserSettingsChanged
		}
		return atomicWrite(path, body, mode)
	})
	if err != nil {
		t.Fatal(err)
	}
	got := parseObj(t, readFile(t, settingsPath()))
	if !changed || got["model"] != nil || got["theme"] != "light" || got["local"].(map[string]any)["literal.key"] != true {
		t.Fatalf("strip lost local update: %v", got)
	}
	if len(loadManagedState().KeyPaths) != 0 {
		t.Fatal("successful strip did not clear ownership")
	}
}
