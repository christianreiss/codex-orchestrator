package claude

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/sessionguard"
)

func TestClaudeOrphanKeepsHousekeepingGuard(t *testing.T) {
	const stage = "CXX_CLAUDE_HOUSEKEEPING_CHILD"
	if mode := os.Getenv(stage); mode != "" {
		var err error
		if mode == "help" {
			_, err = RunHelpPassthrough(context.Background(), os.Getenv("CLX_CLAUDE_BIN"), []string{"claude", "--help"}, os.Environ(), nil, io.Discard, io.Discard, nil)
		} else {
			_, _, err = RunCapture(context.Background(), &config.Config{}, []string{"--version"})
		}
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	for _, mode := range []string{"run", "help"} {
		t.Run(mode, func(t *testing.T) {
			home := t.TempDir()
			ready := filepath.Join(home, "ready")
			release := filepath.Join(home, "release")
			binary := filepath.Join(home, "claude")
			if err := os.WriteFile(binary, []byte("#!/bin/sh\n: > \"$CXX_GUARD_READY\"\nwhile [ ! -e \"$CXX_GUARD_RELEASE\" ]; do sleep 0.01; done\n"), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("HOME", home)
			t.Setenv("CLX_CLAUDE_BIN", binary)
			t.Setenv("CXX_GUARD_READY", ready)
			t.Setenv("CXX_GUARD_RELEASE", release)
			cmd := exec.Command(os.Args[0], "-test.run=^TestClaudeOrphanKeepsHousekeepingGuard$")
			cmd.Env = append(os.Environ(), stage+"="+mode)
			// Do not retain a pipe held by the orphan when the test wrapper is killed.
			devnull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer devnull.Close()
			cmd.Stdout = devnull
			cmd.Stderr = devnull
			if err = cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = os.WriteFile(release, nil, 0600); _ = cmd.Process.Kill() }()
			deadline := time.Now().Add(3 * time.Second)
			for {
				if _, err = os.Stat(ready); err == nil {
					break
				}
				if time.Now().After(deadline) {
					_ = cmd.Process.Kill()
					_ = cmd.Wait()
					t.Fatal("native child never ready")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if err = cmd.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			_ = cmd.Wait()
			root := filepath.Join(home, ".claude")
			if guard, err := sessionguard.Maintenance(root); !errors.Is(err, ipc.ErrHeld) {
				if guard != nil {
					_ = guard.Release()
				}
				t.Fatalf("orphan lost housekeeping guard: %v", err)
			}
			if err = os.WriteFile(release, nil, 0600); err != nil {
				t.Fatal(err)
			}
			deadline = time.Now().Add(3 * time.Second)
			for {
				guard, err := sessionguard.Maintenance(root)
				if err == nil {
					_ = guard.Release()
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("guard outlived child", err)
				}
				time.Sleep(10 * time.Millisecond)
			}
		})
	}
}
