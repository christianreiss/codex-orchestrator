//go:build linux

package grokreap

import (
	"bufio"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// userHZ is the kernel's fixed USER_HZ for /proc/<pid>/stat start times.
const userHZ = 100

// ProcFS reads /proc. Root is "/proc" unless a test points it elsewhere.
type ProcFS struct{ Root string }

func (f ProcFS) root() string {
	if f.Root == "" {
		return "/proc"
	}
	return f.Root
}

func gone(err error) error {
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ESRCH) {
		return ErrGone
	}
	return err
}

func (f ProcFS) PIDs() ([]int, error) {
	entries, err := os.ReadDir(f.root())
	if err != nil {
		return nil, err
	}
	var pids []int
	for _, e := range entries {
		if pid, err := strconv.Atoi(e.Name()); err == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids, nil
}

func (f ProcFS) stat(pid int) (state byte, ppid int, start uint64, err error) {
	raw, err := os.ReadFile(filepath.Join(f.root(), strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0, 0, 0, gone(err)
	}
	// comm may contain spaces and parentheses; fields resume after the last ')'.
	i := strings.LastIndexByte(string(raw), ')')
	if i < 0 || i+2 > len(raw) {
		return 0, 0, 0, errors.New("malformed stat")
	}
	fields := strings.Fields(string(raw[i+2:]))
	if len(fields) < 20 {
		return 0, 0, 0, errors.New("malformed stat")
	}
	ppid, err = strconv.Atoi(fields[1])
	if err != nil {
		return 0, 0, 0, err
	}
	start, err = strconv.ParseUint(fields[19], 10, 64)
	return fields[0][0], ppid, start, err
}

var bootTime = func() (time.Time, error) {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return time.Time{}, err
	}
	defer file.Close()
	sc := bufio.NewScanner(file)
	for sc.Scan() {
		if rest, ok := strings.CutPrefix(sc.Text(), "btime "); ok {
			secs, err := strconv.ParseInt(strings.TrimSpace(rest), 10, 64)
			if err != nil {
				return time.Time{}, err
			}
			return time.Unix(secs, 0), nil
		}
	}
	return time.Time{}, errors.New("btime missing from /proc/stat")
}

func (f ProcFS) Process(pid int) (Process, error) {
	dir := filepath.Join(f.root(), strconv.Itoa(pid))
	state, ppid, start, err := f.stat(pid)
	if err != nil {
		return Process{}, err
	}
	if state == 'Z' || state == 'X' {
		return Process{}, ErrGone
	}
	info, err := os.Stat(dir)
	if err != nil {
		return Process{}, gone(err)
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return Process{}, errors.New("process owner unavailable")
	}
	p := Process{PID: pid, PPID: ppid, UID: st.Uid, StartTicks: start}
	// Unreadable for foreign and non-dumpable processes: identity then rests
	// on argv, and such a process never matches the managed-leader rule.
	if exe, err := os.Readlink(filepath.Join(dir, "exe")); err == nil {
		p.Exe = strings.TrimSuffix(exe, " (deleted)")
	}
	raw, err := os.ReadFile(filepath.Join(dir, "cmdline"))
	if err != nil {
		return Process{}, gone(err)
	}
	if s := strings.TrimRight(string(raw), "\x00"); s != "" {
		p.Argv = strings.Split(s, "\x00")
	}
	// The fields above were read one file at a time; a PID reused in
	// between would mix two processes. The start time pins one lifetime.
	if _, _, again, err := f.stat(pid); err != nil || again != start {
		return Process{}, ErrGone
	}
	boot, err := bootTime()
	if err != nil {
		return Process{}, err
	}
	p.Start = boot.Add(time.Duration(start) * time.Second / userHZ)
	return p, nil
}

func (f ProcFS) Environ(pid int) (map[string]string, error) {
	raw, err := os.ReadFile(filepath.Join(f.root(), strconv.Itoa(pid), "environ"))
	if err != nil {
		return nil, gone(err)
	}
	env := map[string]string{}
	for _, item := range strings.Split(string(raw), "\x00") {
		if k, v, ok := strings.Cut(item, "="); ok {
			env[k] = v
		}
	}
	return env, nil
}

func (f ProcFS) OpenFiles(pid int) ([]string, error) {
	dir := filepath.Join(f.root(), strconv.Itoa(pid), "fd")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, gone(err)
	}
	var out []string
	for _, e := range entries {
		if target, err := os.Readlink(filepath.Join(dir, e.Name())); err == nil {
			out = append(out, strings.TrimSuffix(target, " (deleted)"))
		}
	}
	return out, nil
}

// FlockProbe takes a non-blocking exclusive flock on an existing regular
// file. It never creates the file (unlike ipc.TryAcquireExclusivePath).
type FlockProbe struct{}

func (FlockProbe) TryExclusive(path string) (func(), error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("lock is not a regular file")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrHeld
		}
		return nil, err
	}
	return func() { _ = file.Close() }, nil
}

// ProcLocks is the passive dry-run probe: it reports a lock held when any
// /proc/locks entry names the file's inode. It takes no lock itself. The
// device is not compared (btrfs reports a different one), which can only
// over-report "held".
type ProcLocks struct{ Path string }

func (p ProcLocks) TryExclusive(path string) (func(), error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() {
		return nil, errors.New("lock is not a regular file")
	}
	src := p.Path
	if src == "" {
		src = "/proc/locks"
	}
	raw, err := os.ReadFile(src)
	if err != nil {
		return nil, err
	}
	want := ":" + strconv.FormatUint(st.Ino, 10)
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 6 || fields[1] == "->" { // "->" marks a blocked waiter
			continue
		}
		if strings.HasSuffix(fields[5], want) {
			return nil, ErrHeld
		}
	}
	return func() {}, nil
}

// PidfdSignaler pins the target with pidfd_open before verifying it, so the
// PID cannot be reused between the identity check and the signal.
type PidfdSignaler struct{}

func (PidfdSignaler) Signal(pid int, sig syscall.Signal, verify func() error) error {
	fd, err := unix.PidfdOpen(pid, 0)
	if errors.Is(err, unix.ESRCH) {
		return ErrGone
	}
	if errors.Is(err, unix.ENOSYS) {
		// Kernels before 5.3: the narrowest fallback is verify-then-kill.
		if err := verify(); err != nil {
			return err
		}
		return gone(syscall.Kill(pid, sig))
	}
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	if err := verify(); err != nil {
		return err
	}
	return gone(unix.PidfdSendSignal(fd, sig, nil, 0))
}

// Live returns the production collaborators for this host.
func Live(dryRun bool) (Proc, Locks, Signaler, error) {
	if dryRun {
		return ProcFS{}, ProcLocks{}, refuseSignals{}, nil
	}
	return ProcFS{}, FlockProbe{}, PidfdSignaler{}, nil
}
