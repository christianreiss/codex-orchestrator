package grok

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestPrivateDirectoryWaitUsesKernelLifetimeAndRetainsOtherHolders(t *testing.T) {
	fd, err := unix.PidfdOpen(os.Getpid(), 0)
	if err != nil {
		t.Skipf("pidfd unavailable: %v", err)
	}
	_ = unix.Close(fd)
	dir := t.TempDir()
	start := func(home string) *exec.Cmd {
		cmd := exec.Command("sleep", "30")
		cmd.Env = []string{"GROK_HOME=" + home}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
		return cmd
	}
	first, second := start(dir), start(filepath.Join(dir, "child"))
	sibling := start(dir + "-other")
	if processUsesPrivateDirectory(sibling.Process.Pid, dir) {
		t.Fatal("sibling path must not hold this directory")
	}
	done := make(chan struct{})
	go func() { waitPrivateDirectoryIdle(dir); close(done) }()
	waitPrivate(t, func() bool {
		entries, _ := os.ReadDir("/proc/self/fd")
		for _, entry := range entries {
			target, _ := os.Readlink(filepath.Join("/proc/self/fd", entry.Name()))
			if strings.Contains(target, "pidfd") {
				return true
			}
		}
		return false
	})
	_ = first.Process.Kill()
	_ = first.Wait()
	select {
	case <-done:
		t.Fatal("surviving holder lost its private-directory fence")
	case <-time.After(100 * time.Millisecond):
	}
	_ = second.Process.Kill()
	_ = second.Wait()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("kernel exit failed to wake directory cleanup")
	}
}
