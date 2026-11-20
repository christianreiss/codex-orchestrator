package privatehome

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

func (s *Spec) inUse(dir string) bool {
	pid, err := s.holder(dir)
	return err != nil || pid != 0
}

func (s *Spec) holder(dir string) (int, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, err
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		if s.processUses(pid, dir) {
			return pid, nil
		}
	}
	return 0, nil
}

func (s *Spec) processUses(pid int, dir string) bool {
	raw, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "environ"))
	if err != nil {
		return false
	}
	for _, item := range strings.Split(string(raw), "\x00") {
		key, value, _ := strings.Cut(item, "=")
		if s.envKey(key) && (value == dir || strings.HasPrefix(value, dir+string(os.PathSeparator))) {
			return true
		}
	}
	return false
}

func (s *Spec) envKey(key string) bool {
	for _, k := range s.EnvKeys {
		if key == k {
			return true
		}
	}
	return false
}

// A native child can close the inherited lease while keeping its private home.
// Wait on that process's kernel lifetime instead of rescanning all of /proc ten
// times a second. Always rescan after exit to protect surviving descendants.
func (s *Spec) waitIdle(dir string) {
	for {
		pid, err := s.holder(dir)
		if err == nil && pid == 0 {
			return
		}
		if err != nil {
			time.Sleep(30 * time.Second)
			continue
		}
		fd, err := unix.PidfdOpen(pid, 0)
		if err != nil {
			if err != unix.ESRCH {
				// Old kernels and restricted hosts retain the conservative fence,
				// but never fall back to the former busy full-process scan.
				time.Sleep(time.Second)
			}
			continue
		}
		// Opening before rechecking prevents PID reuse from selecting an
		// unrelated process as the lifetime we wait for.
		if s.processUses(pid, dir) {
			for {
				_, err = unix.Poll([]unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}, -1)
				if err != unix.EINTR {
					break
				}
			}
		}
		_ = unix.Close(fd)
		if err != nil {
			time.Sleep(time.Second)
		}
	}
}
