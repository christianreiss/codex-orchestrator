//go:build !windows

package nativeprocess

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func waitFile(t *testing.T, path string) []byte {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(path); err == nil {
			return data
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("fixture never created %s", path)
	return nil
}

func TestSignalSupervisorFixture(t *testing.T) {
	if os.Getenv("CXX_TEST_SIGNAL_FIXTURE") != "1" {
		return
	}
	ctx, stop := NotifyContext(context.Background())
	defer stop()
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", `
trap 'printf INT > "$CXX_TEST_HANDLED"; exit 0' INT
trap 'printf TERM > "$CXX_TEST_HANDLED"; exit 0' TERM
trap 'printf HUP > "$CXX_TEST_HANDLED"; exit 0' HUP
: > "$CXX_TEST_READY"
while :; do sleep 0.05; done
`)
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	supervisor := Prepare(ctx, cmd, true)
	err := cmd.Run()
	supervisor.Close()
	code, resultErr := supervisor.Result(err)
	if resultErr != nil {
		os.Exit(99)
	}
	os.Exit(code)
}

func TestWrapperSignalsReachCatchableNativeHandlers(t *testing.T) {
	for _, tc := range []struct {
		name string
		sig  syscall.Signal
	}{{"INT", syscall.SIGINT}, {"TERM", syscall.SIGTERM}, {"HUP", syscall.SIGHUP}} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			ready, handled := filepath.Join(dir, "ready"), filepath.Join(dir, "handled")
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestSignalSupervisorFixture$")
			cmd.Env = append(os.Environ(), "CXX_TEST_SIGNAL_FIXTURE=1", "CXX_TEST_READY="+ready, "CXX_TEST_HANDLED="+handled)
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = cmd.Process.Kill() })
			waitFile(t, ready)
			if err := cmd.Process.Signal(tc.sig); err != nil {
				t.Fatal(err)
			}
			err := cmd.Wait()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 128+int(tc.sig) {
				t.Fatalf("exit = %v, want %d", err, 128+int(tc.sig))
			}
			if got := string(waitFile(t, handled)); got != tc.name {
				t.Fatalf("native handler %q, want %q", got, tc.name)
			}
		})
	}
}

func TestCancellationEscalatesAndReapsOwnedDescendants(t *testing.T) {
	dir := t.TempDir()
	ready := filepath.Join(dir, "ready")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", `trap '' INT TERM HUP; sleep 60 & echo "$!" > "$CXX_TEST_READY"; wait`)
	cmd.Env = append(os.Environ(), "CXX_TEST_READY="+ready)
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	supervisor := prepare(ctx, cmd, true, 80*time.Millisecond)
	defer supervisor.Close()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(waitFile(t, ready))))
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	cancel()
	err = cmd.Wait()
	supervisor.Close()
	code, resultErr := supervisor.Result(err)
	if code != 137 || resultErr != nil {
		t.Fatalf("exit = %d, %v; want SIGKILL", code, resultErr)
	}
	if elapsed := time.Since(started); elapsed < 60*time.Millisecond || elapsed > 2*time.Second {
		t.Fatalf("unbounded or immediate kill: %v", elapsed)
	}
	// Kill delivers SIGKILL asynchronously, and Wait only joins the direct child.
	// Allow the descendant to be scheduled to handle the pending fatal signal.
	// Linux may then retain it as a zombie until PID 1 reaps it; a zombie holds
	// neither descriptors nor executable work. A live descendant still fails.
	if runtime.GOOS == "linux" {
		deadline := time.Now().Add(time.Second)
		for {
			status, readErr := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
			if errors.Is(readErr, os.ErrNotExist) || errors.Is(readErr, syscall.ESRCH) {
				break
			}
			if readErr != nil {
				t.Fatalf("read descendant state: %v", readErr)
			}
			fields := strings.Fields(string(status))
			if len(fields) >= 3 && fields[2] == "Z" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("descendant survived group cleanup: %s", status)
			}
			time.Sleep(time.Millisecond)
		}
	}
}

func TestChildSignalExitUsesShellStatus(t *testing.T) {
	for _, sig := range []string{"TERM", "KILL", "INT"} {
		t.Run(sig, func(t *testing.T) {
			ctx := context.Background()
			cmd := exec.CommandContext(ctx, "/bin/sh", "-c", "kill -"+sig+" $$")
			supervisor := Prepare(ctx, cmd, true)
			err := cmd.Run()
			supervisor.Close()
			code, resultErr := supervisor.Result(err)
			want := map[string]int{"TERM": 143, "KILL": 137, "INT": 130}[sig]
			if code != want || resultErr != nil {
				t.Fatalf("exit = %d, %v; want %d", code, resultErr, want)
			}
		})
	}
}

func TestForegroundChildKeepsInheritedGroup(t *testing.T) {
	cmd := exec.CommandContext(context.Background(), "/bin/sh", "-c", "exit 0")
	supervisor := Prepare(context.Background(), cmd, false)
	defer supervisor.Close()
	if cmd.SysProcAttr != nil && (cmd.SysProcAttr.Setpgid || cmd.SysProcAttr.Foreground || cmd.SysProcAttr.Setsid) {
		t.Fatal("foreground group changed")
	}
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
}
