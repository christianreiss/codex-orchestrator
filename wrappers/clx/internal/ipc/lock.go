package ipc

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

type Lock struct{ f *os.File }

var ErrHeld = errors.New("another wrapper instance is running")

func Acquire(name string) (*Lock, error) {
	path := lockPath(name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
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
	_ = f.Truncate(0)
	_, _ = f.Seek(0, 0)
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

// CountActive walks /proc and reports same-UID processes whose short name
// exactly matches name. It returns a conservative floor of one when /proc is
// unavailable or the caller cannot be observed.
func CountActive(name string) int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 1
	}
	myUID := uint32(os.Getuid())
	want := []byte(name)
	count := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid := entry.Name()
		if pid == "" || pid[0] < '0' || pid[0] > '9' {
			continue
		}
		comm, err := os.ReadFile(filepath.Join("/proc", pid, "comm"))
		if err != nil {
			continue
		}
		for len(comm) > 0 && (comm[len(comm)-1] == '\n' || comm[len(comm)-1] == ' ') {
			comm = comm[:len(comm)-1]
		}
		if !bytesEqual(comm, want) {
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
