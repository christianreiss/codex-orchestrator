// Package claudeconfiglock takes Claude Code's own lock on its global config
// file (~/.claude.json) so the wrapper's read-modify-rename cannot interleave
// with a native save.
//
// Claude Code saves the global config through saveConfigWithLock, which uses
// the bundled proper-lockfile library with lockfilePath "<config>.lock" and the
// library defaults (verified in the managed 2.1.317 and 2.1.318 binaries; see
// docs/NATIVE_CONFIG_SCOPES.md):
//
//   - the lock is a DIRECTORY created with mkdir; mkdir's atomicity is the mutex;
//   - on EEXIST the holder is live unless the directory's mtime is older than
//     10s (stale); a stale directory is rmdir'ed and mkdir is retried once;
//   - a native holder refreshes the mtime every 5s while it holds the lock;
//   - release is rmdir.
//
// There is no PID or owner file: liveness is the mtime alone. This package
// mirrors exactly that and never steals a lock whose mtime is fresh.
package claudeconfiglock

import (
	"errors"
	"fmt"
	"io/fs"
	"math/rand/v2"
	"os"
	"path/filepath"
	"time"
)

// Stale is proper-lockfile's default stale threshold, which Claude Code uses.
const Stale = 10 * time.Second

// ErrLocked reports that a live process (fresh lock mtime) kept the lock for
// the whole retry budget. Callers must skip the write, not fall back to an
// unlocked one.
var ErrLocked = errors.New("claude config lock is held by a live process")

// ErrLost reports that the lock directory disappeared or changed under the
// holder (another process judged it stale), so the guarded write must not land.
var ErrLost = errors.New("claude config lock was lost before the write")

// Options tunes acquisition; zero values pick the defaults.
type Options struct {
	// Budget bounds the total time spent retrying a held lock (default 3s,
	// deliberately shorter than native's ~10-20s: the wrapper retries on the
	// next sync instead).
	Budget time.Duration
	// Stale overrides the stale threshold (tests only; native uses 10s).
	Stale time.Duration
	Now   func() time.Time
	Sleep func(time.Duration)
}

// backoff mirrors the shape of Claude Code's own schedule
// (200,400,800,1600,3200,4000 ms times 1+random) within a shorter budget.
var backoff = []time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 400 * time.Millisecond, 800 * time.Millisecond, 1600 * time.Millisecond}

func (o Options) withDefaults() Options {
	if o.Budget <= 0 {
		o.Budget = 3 * time.Second
	}
	if o.Stale <= 0 {
		o.Stale = Stale
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Sleep == nil {
		o.Sleep = time.Sleep
	}
	return o
}

// Path returns the lock directory Claude Code uses for configPath. Native
// passes an explicit lockfilePath built from the unresolved config path, so a
// symlinked config is still locked next to the link.
func Path(configPath string) string { return configPath + ".lock" }

// Lock is one held acquisition.
type Lock struct {
	dir      string
	mtime    time.Time
	acquired time.Time
	opts     Options
}

// HeldError carries the observed lock age for the caller's log line.
type HeldError struct {
	Path string
	Age  time.Duration
}

func (e *HeldError) Error() string {
	return fmt.Sprintf("%s held (lock age %s)", e.Path, e.Age.Round(time.Millisecond))
}
func (e *HeldError) Unwrap() error { return ErrLocked }

// Acquire takes the lock for configPath, retrying a live holder within the
// budget. It returns an error wrapping ErrLocked when the holder stayed live.
func Acquire(configPath string, opts Options) (*Lock, error) {
	opts = opts.withDefaults()
	dir := Path(configPath)
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return nil, err
	}
	deadline := opts.Now().Add(opts.Budget)
	for attempt := 0; ; attempt++ {
		l, err := tryAcquire(dir, opts, true)
		if err == nil {
			return l, nil
		}
		if !errors.Is(err, ErrLocked) {
			return nil, err
		}
		d := backoff[min(attempt, len(backoff)-1)]
		d = time.Duration(float64(d) * (1 + rand.Float64()))
		if remaining := deadline.Sub(opts.Now()); remaining <= 0 {
			return nil, err
		} else if d > remaining {
			d = remaining
		}
		opts.Sleep(d)
	}
}

// tryAcquire is one proper-lockfile acquire attempt: mkdir, and on EEXIST
// judge staleness by mtime; a stale directory is removed and mkdir is retried
// once without the stale allowance (a second EEXIST is a live holder).
func tryAcquire(dir string, opts Options, allowStale bool) (*Lock, error) {
	err := os.Mkdir(dir, 0o777)
	if err == nil {
		st, serr := os.Stat(dir)
		if serr != nil {
			_ = os.Remove(dir)
			return nil, serr
		}
		now := opts.Now()
		return &Lock{dir: dir, mtime: st.ModTime(), acquired: now, opts: opts}, nil
	}
	if !errors.Is(err, fs.ErrExist) {
		return nil, err
	}
	st, serr := os.Stat(dir)
	if serr != nil {
		if errors.Is(serr, fs.ErrNotExist) {
			// Released between mkdir and stat: retry at once, as native does.
			return tryAcquire(dir, opts, false)
		}
		return nil, serr
	}
	age := opts.Now().Sub(st.ModTime())
	if !allowStale || age <= opts.Stale {
		return nil, &HeldError{Path: dir, Age: age}
	}
	if !st.IsDir() {
		// Native's rmdir fails here too; never unlink a foreign file.
		return nil, fmt.Errorf("%s is not a lock directory", dir)
	}
	// Re-check right before removal so a holder that refreshed (or a peer that
	// already replaced the stale lock) is not torn down.
	if again, aerr := os.Stat(dir); aerr == nil && !again.ModTime().Equal(st.ModTime()) {
		return nil, &HeldError{Path: dir, Age: opts.Now().Sub(again.ModTime())}
	}
	if rerr := os.Remove(dir); rerr != nil && !errors.Is(rerr, fs.ErrNotExist) {
		return nil, rerr
	}
	return tryAcquire(dir, opts, false)
}

// Check returns nil while the lock is still ours: the directory exists with
// the mtime it had at acquisition, and the hold is short enough that no other
// process can yet consider it stale (the wrapper never refreshes the mtime,
// so it gives up at half the stale threshold, native's refresh interval).
func (l *Lock) Check() error {
	if l == nil {
		return ErrLost
	}
	if l.opts.Now().Sub(l.acquired) >= l.opts.Stale/2 {
		return fmt.Errorf("%w: held longer than %s", ErrLost, l.opts.Stale/2)
	}
	st, err := os.Stat(l.dir)
	if err != nil || !st.IsDir() || !st.ModTime().Equal(l.mtime) {
		return ErrLost
	}
	return nil
}

// Release removes the lock directory if it is still ours.
func (l *Lock) Release() error {
	if l == nil {
		return nil
	}
	st, err := os.Stat(l.dir)
	if err != nil || !st.IsDir() || !st.ModTime().Equal(l.mtime) {
		return ErrLost
	}
	if err := os.Remove(l.dir); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
