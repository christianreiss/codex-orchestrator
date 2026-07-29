package codex

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

func TestBuildEnvIncludesOverrides(t *testing.T) {
	model := "gpt-5.4"
	effort := "high"
	cfg := &config.Config{
		Orchestrator: config.Orchestrator{
			BaseURL: "https://orch.example.com",
			APIKey:  "sk-codex-abc",
		},
		Host:    config.Host{ID: 1, FQDN: "h.example.com"},
		Wrapper: config.Wrapper{Version: "0.6.0"},
		EngineOptions: config.EngineOptions{
			ModelOverride:           &model,
			ReasoningEffortOverride: &effort,
		},
	}
	env := BuildEnv(cfg)
	have := map[string]bool{}
	for _, kv := range env {
		have[kv] = true
	}
	for _, want := range []string{
		"OPENAI_BASE_URL=https://orch.example.com/v1",
		"OPENAI_API_KEY=sk-codex-abc",
		"CDX_MODEL=gpt-5.4",
		"CDX_REASONING_EFFORT=high",
		"CDX_HOST_FQDN=h.example.com",
		"CDX_HOST_ID=1",
		"CDX_WRAPPER_VERSION=0.6.0",
	} {
		if !have[want] {
			t.Errorf("missing %q", want)
		}
	}
}

func TestRunCaptureReturnsPreExecError(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho should-not-run\n"), 0o755); err != nil {
		t.Fatalf("write fake codex: %v", err)
	}
	t.Setenv("CDX_CODEX_BIN", bin)

	cfg := &config.Config{Host: config.Host{FQDN: "definitely-not-this-host.invalid"}}
	exit, out, err := RunCapture(context.Background(), cfg, []string{"--version"})
	if err == nil {
		t.Fatal("expected preexec FQDN error")
	}
	if exit != 1 {
		t.Fatalf("exit = %d, want 1", exit)
	}
	if len(out) != 0 {
		t.Fatalf("captured output = %q, want empty", string(out))
	}
	if !strings.Contains(err.Error(), "does not match baked FQDN") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRunCapturePurgesAuthAfterLastInsecureDirectCommand(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CDX_CODEX_BIN", bin)
	t.Setenv("CODEX_HOME", t.TempDir())
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	path, _ := AuthPath()
	if err := os.WriteFile(path, []byte(`{"tokens":{"access_token":"temporary"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Host: config.Host{Secure: false}, Orchestrator: config.Orchestrator{BaseURL: "https://example.invalid"}}
	exit, _, err := RunCapture(context.Background(), cfg, []string{"--version"})
	if err != nil || exit != 0 {
		t.Fatalf("RunCapture = %d, %v", exit, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("direct insecure command left auth behind: %v", err)
	}
}

func TestRunCapturePreparedHoldsActiveChildLeaseThroughWait(t *testing.T) {
	dir := t.TempDir()
	ready := filepath.Join(dir, "child-ready")
	bin := filepath.Join(t.TempDir(), "codex")
	script := "#!/bin/sh\ntouch \"$CODEX_HOME/child-ready\"\nsleep 0.4\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CDX_CODEX_BIN", bin)
	t.Setenv("CODEX_HOME", dir)
	path, _ := AuthPath()
	original := []byte(`{"last_refresh":"2026-07-17T08:00:00Z","tokens":{"access_token":"child-window"}}`)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	expected, _ := CurrentAuthGeneration()
	type result struct {
		exit int
		err  error
	}
	done := make(chan result, 1)
	go func() {
		exit, _, err := RunCapturePrepared(context.Background(), &config.Config{Host: config.Host{Secure: true}}, []string{"--version"})
		done <- result{exit: exit, err: err}
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child did not enter its active interval")
		}
		time.Sleep(10 * time.Millisecond)
	}
	wrote, err := WriteAuthIfCurrent([]byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"late-server"}}`), expected)
	if err != nil || !wrote {
		t.Fatalf("canonical write overlapped native child: wrote=%v err=%v", wrote, err)
	}
	got := <-done
	if got.err != nil || got.exit != 0 {
		t.Fatalf("child result = exit=%d err=%v", got.exit, got.err)
	}
	if raw, err := os.ReadFile(path); err != nil || !bytes.Contains(raw, []byte("late-server")) {
		t.Fatalf("canonical auth missing during child interval: %q, %v", raw, err)
	}
}

func TestNativeChildInheritsAuthLeasesAfterWrapperSIGKILL(t *testing.T) {
	const stageEnv = "CDX_CHILD_LEASE_SIGKILL_STAGE"
	if os.Getenv(stageEnv) == "wrapper" {
		_, _, err := RunCapturePrepared(context.Background(), &config.Config{Host: config.Host{Secure: true}}, []string{"--version"})
		if err != nil {
			t.Fatal(err)
		}
		return
	}

	dir := t.TempDir()
	ready := filepath.Join(dir, "orphan-ready")
	bin := filepath.Join(t.TempDir(), "codex")
	script := "#!/bin/sh\ntouch \"$CODEX_HOME/orphan-ready\"\nsleep 0.8\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "auth.json")
	original := []byte(`{"last_refresh":"2026-07-17T08:00:00Z","tokens":{"access_token":"orphan-child"}}`)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(os.Args[0], "-test.run=^TestNativeChildInheritsAuthLeasesAfterWrapperSIGKILL$")
	cmd.Env = replaceEnvForTest(os.Environ(), stageEnv, "wrapper")
	cmd.Env = replaceEnvForTest(cmd.Env, "CODEX_HOME", dir)
	cmd.Env = replaceEnvForTest(cmd.Env, "CDX_CODEX_BIN", bin)
	devNull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer devNull.Close()
	cmd.Stdout = devNull
	cmd.Stderr = devNull
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			t.Fatal("native child did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()

	t.Setenv("CODEX_HOME", dir)
	if maintenance, err := TryAcquireAuthMaintenance(); !errors.Is(err, ipc.ErrHeld) {
		if maintenance != nil {
			_ = maintenance.Release()
		}
		t.Fatalf("orphan child lost inherited auth session lease: %v", err)
	}
	expected, _ := CurrentAuthGeneration()
	result, err := WriteAuthIfCurrentDetailed([]byte(`{"last_refresh":"2026-07-17T10:00:00Z","tokens":{"access_token":"server"}}`), expected)
	if err != nil || !result.Written || result.BlockedByActiveChild {
		t.Fatalf("orphan child blocked guarded canonical write = %+v, %v", result, err)
	}

	deadline = time.Now().Add(3 * time.Second)
	for {
		maintenance, err := TryAcquireAuthMaintenance()
		if err == nil {
			_ = maintenance.Release()
			break
		}
		if !errors.Is(err, ipc.ErrHeld) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("inherited auth leases survived native child exit")
		}
		time.Sleep(20 * time.Millisecond)
	}
	current, _ := CurrentAuthGeneration()
	result, err = WriteAuthIfCurrentDetailed([]byte(`{"last_refresh":"2026-07-17T11:00:00Z","tokens":{"access_token":"server-2"}}`), current)
	if err != nil || !result.Written {
		t.Fatalf("write after orphan child exit = %+v, %v", result, err)
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
	// FindCLI can refuse it (the `codex`-shadows-`cdx` recursion guard).
	link := filepath.Join(t.TempDir(), "codex")
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
