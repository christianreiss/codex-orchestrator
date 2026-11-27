//go:build windows

package posix

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// The fail-closed contract: a no-follow open never silently follows.
func TestNoFollowOpenIsRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := OpenFile(path, os.O_RDWR|O_NOFOLLOW, 0)
	if !errors.Is(err, errNoFollow) {
		if f != nil {
			_ = f.Close()
		}
		t.Fatalf("OpenFile(O_NOFOLLOW) = %v, want errNoFollow", err)
	}
	// Second layer: the sentinel bit is rejected even by os.OpenFile.
	f, err = os.OpenFile(path, os.O_RDWR|O_NOFOLLOW, 0)
	if err == nil {
		_ = f.Close()
		t.Fatal("os.OpenFile accepted the O_NOFOLLOW sentinel bit")
	}
}

// No real os.FileInfo may ever satisfy an owner check.
func TestStatNeverCarriesStat_t(t *testing.T) {
	info, err := os.Stat(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := info.Sys().(*Stat_t); ok {
		t.Fatal("os.FileInfo.Sys() returned *posix.Stat_t")
	}
}

func TestFlockExclusiveContends(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock")
	open := func() *os.File {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = f.Close() })
		return f
	}
	a, b := open(), open()
	if err := Flock(int(a.Fd()), LOCK_EX|LOCK_NB); err != nil {
		t.Fatalf("first exclusive lock: %v", err)
	}
	if err := Flock(int(b.Fd()), LOCK_SH|LOCK_NB); !errors.Is(err, syscall.EWOULDBLOCK) {
		t.Fatalf("contended shared lock = %v, want EWOULDBLOCK", err)
	}
	if err := Flock(int(a.Fd()), LOCK_SH|LOCK_NB); err != nil {
		t.Fatalf("downgrade to shared: %v", err)
	}
	if err := Flock(int(b.Fd()), LOCK_SH|LOCK_NB); err != nil {
		t.Fatalf("second shared lock: %v", err)
	}
	if err := Flock(int(b.Fd()), LOCK_EX|LOCK_NB); !errors.Is(err, syscall.EWOULDBLOCK) {
		t.Fatalf("upgrade past a shared peer = %v, want EWOULDBLOCK", err)
	}
	if err := Flock(int(a.Fd()), LOCK_UN); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	if err := Flock(int(b.Fd()), LOCK_EX|LOCK_NB); err != nil {
		t.Fatalf("exclusive after peer unlock: %v", err)
	}
	// The locked byte lies beyond the data, so a peer can still read it.
	if _, err := os.ReadFile(path); err != nil {
		t.Fatalf("read while locked: %v", err)
	}
}
