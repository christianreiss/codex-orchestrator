//go:build linux

package nativeprocess

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestTTYSupervisorFixture(t *testing.T) {
	if os.Getenv("CXX_TEST_TTY_FIXTURE") != "1" {
		return
	}
	ctx, stop := NotifyContext(context.Background())
	defer stop()
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", `
trap 'echo caught > "$CXX_TEST_HANDLED"; exit 0' TERM
: > "$CXX_TEST_READY"
read value
printf '%s' "$value" > "$CXX_TEST_READ"
while :; do sleep 0.02; done
`)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	supervisor := Prepare(ctx, cmd, Headless(cmd.Stdin))
	err := cmd.Run()
	supervisor.Close()
	code, _ := supervisor.Result(err)
	os.Exit(code)
}

func TestTerminalChildCanReadForegroundTTYAndFinishHandler(t *testing.T) {
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	if err := unix.IoctlSetPointerInt(int(master.Fd()), unix.TIOCSPTLCK, 0); err != nil {
		t.Fatal(err)
	}
	number, err := unix.IoctlGetInt(int(master.Fd()), unix.TIOCGPTN)
	if err != nil {
		t.Fatal(err)
	}
	slave, err := os.OpenFile(fmt.Sprintf("/dev/pts/%d", number), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer slave.Close()
	dir := t.TempDir()
	ready, read, handled := filepath.Join(dir, "ready"), filepath.Join(dir, "read"), filepath.Join(dir, "handled")
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestTTYSupervisorFixture$")
	cmd.Env = append(os.Environ(), "CXX_TEST_TTY_FIXTURE=1", "CXX_TEST_READY="+ready, "CXX_TEST_READ="+read, "CXX_TEST_HANDLED="+handled)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) })
	waitFile(t, ready)
	if _, err := master.WriteString("foreground input\n"); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(waitFile(t, read))); got != "foreground input" {
		t.Fatalf("TTY read %q", got)
	}
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err == nil || cmd.ProcessState.ExitCode() != 143 {
		t.Fatalf("TTY shutdown %v", err)
	}
	if got := strings.TrimSpace(string(waitFile(t, handled))); got != "caught" {
		t.Fatalf("TTY TERM handler %q", got)
	}
}
