package grok

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

// Runs in an actual independent wrapper process so SIGKILL cannot run defers.
func TestPrivateDirectoryOwnerProcess(t *testing.T) {
	if os.Getenv("CXX_TEST_PRIVATE_OWNER") != "1" {
		return
	}
	dir, ready := os.Getenv("CXX_TEST_PRIVATE_DIR"), os.Getenv("CXX_TEST_READY")
	lifetime, err := ipc.TryAcquireSharedPath(filepath.Join(filepath.Dir(dir), "lifetime.lock"))
	if err != nil {
		panic(err)
	}
	guard, err := GuardPrivateDirectory(dir, lifetime)
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte("test-access-secret"), 0600); err != nil {
		panic(err)
	}
	if os.Getenv("CXX_TEST_CHILD") != "" {
		script := `echo ready > "$CXX_TEST_CHILD_READY"; exec sleep 30`
		if os.Getenv("CXX_TEST_CHILD") == "close-fds" {
			script = `exec 3<&-; echo ready > "$CXX_TEST_CHILD_READY"; exec sleep 30`
		}
		cmd := exec.Command("/bin/sh", "-c", script)
		cmd.Env = append(os.Environ(), "GROK_HOME="+dir)
		release, err := guard.Attach(cmd)
		if err != nil {
			panic(err)
		}
		if err := cmd.Start(); err != nil {
			release()
			panic(err)
		}
		release()
		if err := os.WriteFile(ready, []byte(strconv.Itoa(cmd.Process.Pid)), 0600); err != nil {
			panic(err)
		}
	} else {
		_ = os.WriteFile(ready, []byte("0"), 0600)
	}
	select {}
}

func waitPrivate(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("private runtime condition did not become true")
}

func TestPrivateDirectorySIGKILLOwner(t *testing.T) {
	for _, child := range []string{"", "inherits-fd", "close-fds"} {
		t.Run(child, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, "session-secret")
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			ready, childReady := filepath.Join(root, "ready"), filepath.Join(root, "child-ready")
			exe, _ := os.Executable()
			cmd := exec.Command(exe, "-test.run=^TestPrivateDirectoryOwnerProcess$")
			cmd.Env = append(os.Environ(), "CXX_TEST_PRIVATE_OWNER=1", "CXX_TEST_PRIVATE_DIR="+dir, "CXX_TEST_READY="+ready, "CXX_TEST_CHILD="+child, "CXX_TEST_CHILD_READY="+childReady)
			var output strings.Builder
			cmd.Stdout = &output
			cmd.Stderr = &output
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = cmd.Process.Kill() }()
			waitPrivate(t, func() bool { _, err := os.Stat(ready); return err == nil })
			raw, _ := os.ReadFile(ready)
			pid, _ := strconv.Atoi(string(raw))
			if pid > 0 {
				defer syscall.Kill(pid, syscall.SIGKILL)
				waitPrivate(t, func() bool { _, err := os.Stat(childReady); return err == nil })
			}
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			if pid > 0 {
				time.Sleep(200 * time.Millisecond)
				if _, err := os.Stat(filepath.Join(dir, "auth.json")); err != nil {
					t.Fatalf("live native directory removed: %v; %s", err, output.String())
				}
				lock, err := ipc.TryAcquireExclusivePath(filepath.Join(root, "lifetime.lock"))
				if err == nil {
					_ = lock.Release()
					t.Fatal("orphan native lost maintenance fence")
				}
				if !errors.Is(err, ipc.ErrHeld) {
					t.Fatal(err)
				}
				_ = syscall.Kill(pid, syscall.SIGKILL)
			}
			waitPrivate(t, func() bool { _, err := os.Stat(dir); return os.IsNotExist(err) })
			waitPrivate(t, func() bool {
				lock, err := ipc.TryAcquireExclusivePath(filepath.Join(root, "lifetime.lock"))
				if err == nil {
					_ = lock.Release()
					return true
				}
				return false
			})
		})
	}
}

func TestPrivateDirectoryFailedChildExecReleasesHandoff(t *testing.T) {
	dir, err := os.MkdirTemp(t.TempDir(), "session-")
	if err != nil {
		t.Fatal(err)
	}
	p, err := GuardPrivateDirectory(dir)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(filepath.Join(dir, "missing"))
	release, err := p.Attach(cmd)
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err == nil {
		t.Fatal("unexpected exec success")
	}
	release()
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal(fmt.Errorf("private directory left after exec failure: %v", err))
	}
}

func TestPrivateDirectoryReaperMustBeReadyBeforeUse(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "invalid-prefix")
	_ = os.Mkdir(dir, 0700)
	if _, err := GuardPrivateDirectory(dir); err == nil {
		t.Fatal("invalid helper accepted")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("failed setup left private directory")
	}
}

func TestSweepPrivateDirectoriesRequiresOwnershipAndIdleLock(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	state, _ := StateDir()
	root := filepath.Join(state, "runtimes")
	_ = os.MkdirAll(root, 0700)
	unowned := filepath.Join(root, "session-unowned")
	_ = os.Mkdir(unowned, 0700)
	idle := filepath.Join(root, "session-idle")
	_ = os.Mkdir(idle, 0700)
	_ = os.WriteFile(filepath.Join(idle, privateLeaseName), nil, 0600)
	live := filepath.Join(root, "session-live")
	_ = os.Mkdir(live, 0700)
	lock, err := ipc.TryAcquireSharedPath(filepath.Join(live, privateLeaseName))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if err := SweepPrivateDirectories(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(idle); !os.IsNotExist(err) {
		t.Fatal("idle owned directory retained")
	}
	for _, dir := range []string{unowned, live} {
		if _, err := os.Stat(dir); err != nil {
			t.Fatalf("protected directory removed: %s", dir)
		}
	}
}
