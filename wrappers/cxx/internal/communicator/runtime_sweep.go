package communicator

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Every server base (and, under the short /tmp fallback, every deep scope) gets
// its own cxx-comm-<hash> directory, and nothing ever removed one: feedback
// 3e2df8d1 found 558 under /run/user/1000, about 70 a day, each holding only an
// idle sync lock. The sweep removes a directory only when nothing can be using
// it: it has not changed for runtimeStaleAge, every lock in it can be taken
// (no owner, fence or worker holds one), no socket in it answers, and it holds
// nothing but lock files, sockets and logs. It takes those locks, renames the
// directory out of the way while holding them, and only then deletes it, so a
// later user re-creates a fresh directory and lock files at the old path. A
// process that opened a lock file before the rename and locks it afterwards
// notices that the path no longer names its file and opens it again (ipc).
const (
	runtimeSweepInterval = time.Hour
	runtimeStaleAge      = time.Hour
	runtimeSweepLimit    = 256
	runtimeSweepStamp    = ".cxx-comm-sweep"
	runtimeReapPrefix    = ".cxx-comm-reap-"
)

// runtimeSweepAutomatic keeps go test binaries from sweeping the real
// per-user runtime root; the sweep's own tests call it on private roots.
var runtimeSweepAutomatic = func() bool {
	exe, err := os.Executable()
	return err == nil && !strings.HasSuffix(exe, ".test")
}

// maybeSweepRuntimeRoot is called on every socket resolution; between passes
// it costs one lstat.
func maybeSweepRuntimeRoot(root string) {
	if runtimeSweepAutomatic() {
		sweepRuntimeRootIfDue(root, time.Now())
	}
}

// sweepRuntimeRootIfDue runs one pass when the root's stamp is older than the
// interval (or in the future) and no other process is sweeping it.
func sweepRuntimeRootIfDue(root string, now time.Time) int {
	stamp := filepath.Join(root, runtimeSweepStamp)
	if info, err := os.Lstat(stamp); err == nil && info.Mode().IsRegular() && recent(info.ModTime(), now, runtimeSweepInterval) {
		return 0
	}
	file, err := os.OpenFile(stamp, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return 0
	}
	defer file.Close()
	if info, err := file.Stat(); err != nil || !info.Mode().IsRegular() || !ownedByUser(info) {
		return 0
	}
	if syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		return 0 // another process is sweeping this root
	}
	if os.Chtimes(stamp, now, now) != nil {
		return 0
	}
	return sweepRuntimeRoot(root, now)
}

// sweepRuntimeRoot inspects at most runtimeSweepLimit candidates and returns
// how many abandoned directories it removed.
func sweepRuntimeRoot(root string, now time.Time) int {
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0
	}
	inspected, removed := 0, 0
	for _, entry := range entries {
		if inspected >= runtimeSweepLimit {
			break
		}
		name := entry.Name()
		switch {
		case runtimeDirName(name):
			inspected++
			if reapRuntimeDir(root, name, now) {
				removed++
			}
		case strings.HasPrefix(name, runtimeReapPrefix):
			// Unreachable by any socket path: a sweeper stopped mid-cleanup.
			inspected++
			removeReaped(filepath.Join(root, name))
		}
	}
	return removed
}

func runtimeDirName(name string) bool {
	hex, ok := strings.CutPrefix(name, socketDirPrefix)
	if !ok || len(hex) != 16 {
		return false
	}
	for _, r := range hex {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

func reapRuntimeDir(root, name string, now time.Time) bool {
	dir := filepath.Join(root, name)
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 || !ownedByUser(info) || recent(info.ModTime(), now, runtimeStaleAge) {
		return false
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	var held []*os.File
	defer func() {
		for _, file := range held {
			_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
			file.Close()
		}
	}()
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		entryInfo, err := os.Lstat(path)
		if err != nil || !ownedByUser(entryInfo) {
			return false
		}
		mode := entryInfo.Mode()
		switch {
		case mode.IsRegular() && strings.HasSuffix(entry.Name(), ".lock"):
			file, err := os.OpenFile(path, os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
			if err != nil {
				return false
			}
			if syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
				file.Close()
				return false // an owner, fence or worker is alive
			}
			held = append(held, file)
		case mode.IsRegular():
			if recent(entryInfo.ModTime(), now, runtimeStaleAge) {
				return false
			}
		case mode&os.ModeSocket != 0:
			if conn, err := net.DialTimeout("unix", path, 200*time.Millisecond); err == nil {
				conn.Close()
				return false
			}
		default:
			return false // never delete what this package does not create
		}
	}
	// Nothing was added while the locks were being taken.
	if again, err := os.Lstat(dir); err != nil || !again.ModTime().Equal(info.ModTime()) {
		return false
	}
	tomb := filepath.Join(root, fmt.Sprintf("%s%s.%d.%d", runtimeReapPrefix, strings.TrimPrefix(name, socketDirPrefix), os.Getpid(), now.UnixNano()))
	if os.Rename(dir, tomb) != nil {
		return false
	}
	removeReaped(tomb)
	return true
}

// removeReaped deletes a tombstone directory this user owns; it never follows
// a symlink.
func removeReaped(path string) {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || !ownedByUser(info) {
		return
	}
	_ = os.RemoveAll(path)
}

func ownedByUser(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Getuid()
}

// recent is true for a time within window before now. A time in the future
// (a clock that was set back) counts as old, so it cannot pin a directory.
func recent(at, now time.Time, window time.Duration) bool {
	return !at.After(now.Add(time.Minute)) && now.Sub(at) < window
}
