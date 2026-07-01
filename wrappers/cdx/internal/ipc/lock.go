// Package ipc provides a process-wide single-instance lock for the wrapper.
// Concurrent invocations on the same host race the same orchestrator state,
// which is why the v1 wrapper had a bash flock wrapper around the whole thing.
package ipc

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// Lock represents an acquired flock; Release closes the underlying fd.
type Lock struct {
	f *os.File
}

// Acquire takes an exclusive non-blocking flock on a per-user lock file. If
// another instance holds it, returns ErrHeld.
var ErrHeld = errors.New("another wrapper instance is running")

func Acquire(name string) (*Lock, error) {
	path := lockPath(name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_TRUNC|syscall.O_NOFOLLOW, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open lock %s: %w", path, err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrHeld
		}
		return nil, err
	}
	_, _ = fmt.Fprintf(f, "%d\n", os.Getpid())
	return &Lock{f: f}, nil
}

func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	_ = syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	err := l.f.Close()
	l.f = nil
	return err
}

func lockPath(name string) string {
	if runtime := os.Getenv("XDG_RUNTIME_DIR"); runtime != "" {
		return filepath.Join(runtime, name+".lock")
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("%s-%d.lock", name, os.Getuid()))
}

// CountActive walks /proc and reports how many processes on this host share
// the given short name (e.g. "cdx") and the caller's uid. Counts the caller
// itself if it's running, so 1 ≈ "just me", 2+ ≈ at least one concurrent peer.
//
// /proc is Linux-only. On platforms without /proc (or when the walk fails for
// any reason — restricted permissions, container weirdness, etc.) the
// function returns 1 so callers can still render a usable value without
// crashing.
func CountActive(name string) int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 1
	}
	myUID := uint32(os.Getuid())
	want := []byte(name)
	count := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid := e.Name()
		if pid == "" || pid[0] < '0' || pid[0] > '9' {
			continue
		}
		comm, err := os.ReadFile(filepath.Join("/proc", pid, "comm"))
		if err != nil {
			continue
		}
		// /proc/<pid>/comm is the binary basename (truncated to 15 chars) +
		// trailing newline; match exactly to avoid false positives like
		// `cdx-debug` or `cdxhelper`.
		trimmed := comm
		for len(trimmed) > 0 && (trimmed[len(trimmed)-1] == '\n' || trimmed[len(trimmed)-1] == ' ') {
			trimmed = trimmed[:len(trimmed)-1]
		}
		if !bytesEqual(trimmed, want) {
			continue
		}
		st, err := os.Stat(filepath.Join("/proc", pid))
		if err != nil {
			continue
		}
		sys, ok := st.Sys().(*syscall.Stat_t)
		if !ok || sys.Uid != myUID {
			continue
		}
		count++
	}
	if count == 0 {
		// At minimum the caller is alive; if /proc gave us 0 it usually means
		// the caller's own /proc/<pid>/comm wasn't readable yet (race during
		// startup), so treat that as 1 rather than reporting zero sessions.
		return 1
	}
	return count
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
