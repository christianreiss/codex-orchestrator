package grok

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

func TestLoginLifetimeOwnerFixture(t *testing.T) {
	if os.Getenv("CXX_LOGIN_OWNER") != "1" {
		return
	}
	if err := login(context.Background(), &config.Config{}, &orchestrator.Client{}, nil, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
}
func TestLoginInheritsPrivateLeaseBeforeExecAndSurvivesLauncherKill(t *testing.T) {
	if _, err := os.Stat("/proc/self/fd"); err != nil {
		t.Skip("Linux descriptor inspection")
	}
	root := t.TempDir()
	ready := filepath.Join(root, "ready")
	binary := filepath.Join(root, "grok")
	base := filepath.Join(root, "native")
	// Assert the actual execute(login) handoff before deliberately closing it.
	// The reaper then has to hold the maintenance lease independently.
	script := `#!/bin/sh
[ "$(readlink /proc/$$/fd/3)" = "$GROK_HOME/.cxx-private-lease" ] || exit 17
exec 3<&-
echo test-secret > "$GROK_AUTH_PATH"
printf '%s\n%s' "$$" "$GROK_HOME" > "$CXX_LOGIN_READY.tmp"
mv "$CXX_LOGIN_READY.tmp" "$CXX_LOGIN_READY"
exec sleep 30
`
	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	exe, _ := os.Executable()
	cmd := exec.Command(exe, "-test.run=^TestLoginLifetimeOwnerFixture$")
	cmd.Env = append(os.Environ(), "HOME="+root, "GROK_HOME="+base, "CGX_GROK_BIN="+binary, "CXX_LOGIN_OWNER=1", "CXX_LOGIN_READY="+ready)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	wait := func(fn func() bool) {
		t.Helper()
		until := time.Now().Add(5 * time.Second)
		for time.Now().Before(until) {
			if fn() {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("login lifetime condition timed out")
	}
	wait(func() bool { _, err := os.Stat(ready); return err == nil })
	raw, _ := os.ReadFile(ready)
	parts := strings.SplitN(string(raw), "\n", 2)
	pid, _ := strconv.Atoi(parts[0])
	dir := parts[1]
	defer syscall.Kill(pid, syscall.SIGKILL)
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	time.Sleep(150 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(dir, "auth.json")); err != nil {
		t.Fatal("live login lost credential home")
	}
	lock, err := native.TryAcquireMaintenance(base)
	if err == nil {
		_ = lock.Release()
		t.Fatal("live orphan login lost maintenance fence")
	}
	if !errors.Is(err, ipc.ErrHeld) {
		t.Fatal(err)
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
	wait(func() bool { _, err := os.Stat(dir); return os.IsNotExist(err) })
}
