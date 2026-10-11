package cron

import (
	"context"
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
)

func TestCoordinatorSignalFixture(t *testing.T) {
	if os.Getenv("CXX_CRON_SIGNAL_FIXTURE") != "1" {
		return
	}
	stubCoordinator(t)
	refreshRunConfigs = func(context.Context, *config.Config, string, io.Writer) ([]*config.Config, []string, string, error) {
		return nil, nil, os.Getenv("CXX_CRON_NATIVE_FIXTURE"), nil
	}
	if err := Run(context.Background(), nil, false, io.Discard, io.Discard); err != nil {
		os.Exit(7)
	}
	os.Exit(0)
}

func TestCoordinatorSignalCancelsTrailingDaemonReconcile(t *testing.T) {
	dir := t.TempDir()
	ready, path := filepath.Join(dir, "ready"), filepath.Join(dir, "daemon")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf '%s' \"$$\" > \"$CXX_CRON_NATIVE_READY\"\nwhile :; do :; done\n"), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestCoordinatorSignalFixture$")
	cmd.Env = append(os.Environ(), "CXX_CRON_SIGNAL_FIXTURE=1", "CXX_CRON_NATIVE_FIXTURE="+path, "CXX_CRON_NATIVE_READY="+ready)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	deadline := time.Now().Add(3 * time.Second)
	var pid int
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(ready); err == nil {
			pid, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
			if pid > 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if pid == 0 {
		t.Fatal("daemon reconcile fixture did not start")
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if err := cmd.Wait(); err == nil || cmd.ProcessState.ExitCode() != 7 {
		t.Fatalf("cancellation did not propagate: %v", err)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("daemon reconcile outlived coordinator cancellation")
	}
	if err := syscall.Kill(pid, 0); err == nil {
		t.Fatal("daemon reconcile remained alive")
	}
}
