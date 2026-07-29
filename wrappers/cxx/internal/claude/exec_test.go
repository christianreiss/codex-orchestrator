package claude

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// RunCapture must refuse to launch Claude when the runtime hostname does not
// match the baked FQDN (the documented launch guard). Before the fix the
// PreExec error was swallowed and Claude launched against the wrong host
// identity. PreExec fails before claude is ever spawned, so this never execs.
func TestRunCaptureRefusesFQDNMismatch(t *testing.T) {
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "")
	// Make FindCLI succeed with a dummy so the test reaches PreExec regardless of
	// whether a real claude is installed; PreExec fails first so it is never run.
	dummy := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(dummy, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", dummy)
	cfg := &config.Config{}
	cfg.Host.FQDN = "totally-different-host.invalid.example.org"
	exit, _, err := RunCapture(context.Background(), cfg, []string{"--version"})
	if err == nil || exit == 0 {
		t.Fatalf("expected refusal, got exit=%d err=%v", exit, err)
	}
	if !strings.Contains(err.Error(), "FQDN") {
		t.Fatalf("expected FQDN mismatch error, got %v", err)
	}
}

func TestActiveClaudeChildPreventsCanonicalRenameUntilWait(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	ready := filepath.Join(home, "child-ready")
	release := filepath.Join(home, "child-release")
	t.Setenv("CLX_TEST_READY", ready)
	t.Setenv("CLX_TEST_RELEASE", release)
	bin := filepath.Join(t.TempDir(), "claude")
	script := `#!/bin/sh
: > "$CLX_TEST_READY"
while [ ! -e "$CLX_TEST_RELEASE" ]; do sleep 0.01; done
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)
	old := json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"old"}}`)
	if err := WriteAuth(old); err != nil {
		t.Fatal(err)
	}
	before, err := ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, _, err := RunCapture(context.Background(), &config.Config{}, nil)
		done <- err
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Claude child did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	newer := json.RawMessage(`{"last_refresh":"2026-07-17T11:00:00Z","claudeAiOauth":{"accessToken":"new"}}`)
	applied, err := WriteAuthIfCurrent(newer, before.Generation)
	if err != nil || !applied {
		t.Fatalf("write during active child applied=%v err=%v", applied, err)
	}
	current, err := ReadAuthSnapshot(false)
	if err != nil || current.Generation == before.Generation {
		t.Fatalf("canonical auth did not advance: current=%+v err=%v", current, err)
	}
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	newest := json.RawMessage(`{"last_refresh":"2026-07-17T12:00:00Z","claudeAiOauth":{"accessToken":"newest"}}`)
	applied, err = WriteAuthIfCurrent(newest, current.Generation)
	if err != nil || !applied {
		t.Fatalf("write after child wait applied=%v err=%v", applied, err)
	}
}

func TestRunCaptureAcquiresChildLeaseBeforeMaterializingAuth(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	authPath, err := AuthPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	const staleKey = "sk-ant-api03-must-not-survive-logout"
	if err := os.WriteFile(authPath, []byte(`{"api_key":"`+staleKey+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	captured := filepath.Join(home, "captured-api-key")
	t.Setenv("CLX_TEST_CAPTURE", captured)
	bin := filepath.Join(t.TempDir(), "claude")
	script := `#!/bin/sh
printf '%s' "${ANTHROPIC_API_KEY-}" > "$CLX_TEST_CAPTURE"
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLX_CLAUDE_BIN", bin)

	acquireStarted := make(chan struct{})
	continueAcquire := make(chan struct{})
	acquire := func() (*authChildLease, error) {
		close(acquireStarted)
		<-continueAcquire
		return acquireAuthChildShared()
	}
	done := make(chan error, 1)
	go func() {
		_, _, runErr := runCaptureWithHeldAuthLeaseUsing(
			context.Background(),
			&config.Config{},
			nil,
			nil,
			nil,
			acquire,
		)
		done <- runErr
	}()

	<-acquireStarted
	if err := os.Remove(authPath); err != nil {
		t.Fatal(err)
	}
	close(continueAcquire)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(captured)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(got), staleKey) {
		t.Fatalf("Claude child launched with API key copied before its auth lease: %q", got)
	}
}

func TestIsWrapperSelf(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Skipf("os.Executable unavailable: %v", err)
	}
	if !isWrapperSelf(self) {
		t.Fatalf("isWrapperSelf(self=%q) = false, want true", self)
	}

	// A symlink pointing at the running binary must resolve back to self so
	// FindCLI skips it (the `claude`-shadows-`clx` recursion guard).
	link := filepath.Join(t.TempDir(), "claude")
	if err := os.Symlink(self, link); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	if !isWrapperSelf(link) {
		t.Fatalf("isWrapperSelf(symlink->self) = false, want true")
	}

	// A genuinely different binary must not be flagged as self.
	for _, other := range []string{"/bin/sh", "/usr/bin/env", "/bin/true"} {
		if _, statErr := os.Stat(other); statErr == nil {
			if isWrapperSelf(other) {
				t.Fatalf("isWrapperSelf(%q) = true, want false", other)
			}
			break
		}
	}
}
