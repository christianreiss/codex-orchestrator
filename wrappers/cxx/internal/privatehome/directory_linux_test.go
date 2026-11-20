package privatehome

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

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

// Every configured key fences the directory, not only the home variable.
func TestEveryEnvKeyHoldsTheDirectory(t *testing.T) {
	spec := &Spec{EnvKeys: []string{"CXX_TEST_PRIVATE_HOME", "CXX_TEST_PRIVATE_AUTH"}}
	dir := t.TempDir()
	cmd := exec.Command("sleep", "30")
	cmd.Env = []string{"CXX_TEST_PRIVATE_AUTH=" + filepath.Join(dir, "auth.json")}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	// /proc shows the new environment only once exec has completed.
	waitPrivate(t, func() bool { return spec.processUses(cmd.Process.Pid, dir) })
	if !spec.inUse(dir) {
		t.Fatal("auth-path holder not detected")
	}
}

func TestPrivateDirectoryWaitUsesKernelLifetimeAndRetainsOtherHolders(t *testing.T) {
	spec := &Spec{EnvKeys: []string{"CXX_TEST_PRIVATE_HOME", "CXX_TEST_PRIVATE_AUTH"}}
	fd, err := unix.PidfdOpen(os.Getpid(), 0)
	if err != nil {
		t.Skipf("pidfd unavailable: %v", err)
	}
	_ = unix.Close(fd)
	dir := t.TempDir()
	start := func(home string) *exec.Cmd {
		cmd := exec.Command("sleep", "30")
		cmd.Env = []string{"CXX_TEST_PRIVATE_HOME=" + home}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
		return cmd
	}
	first, second := start(dir), start(filepath.Join(dir, "child"))
	sibling := start(dir + "-other")
	if spec.processUses(sibling.Process.Pid, dir) {
		t.Fatal("sibling path must not hold this directory")
	}
	done := make(chan struct{})
	go func() { spec.waitIdle(dir); close(done) }()
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
