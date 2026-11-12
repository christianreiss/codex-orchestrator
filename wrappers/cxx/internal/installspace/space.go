// Package installspace gates large installer writes and serializes their peak
// disk use across engines and wrapper processes belonging to the same user.
package installspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

const (
	MiB     uint64 = 1 << 20
	Wrapper        = 512 * MiB
	Native         = 1024 * MiB
	Package        = 2048 * MiB
)

// Need describes additional, simultaneously live bytes, not existing files.
type Need struct {
	Path          string
	Bytes, Inodes uint64
}

type Capacity struct {
	Device        uint64
	Bytes, Inodes uint64
	InodesKnown   bool
}

// Probe is injectable through a context, so installer tests need no full disk.
type Probe func(string) (Capacity, error)
type probeKey struct{}
type leaseKey struct{}

func WithProbe(ctx context.Context, probe Probe) context.Context {
	return context.WithValue(ctx, probeKey{}, probe)
}

// Inspect follows symlinks and resolves missing directories without creating them.
func Inspect(path string) (Capacity, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return Capacity{}, err
	}
	for {
		info, err := os.Stat(path)
		if err == nil {
			if !info.IsDir() {
				path = filepath.Dir(path)
			}
			break
		}
		if !os.IsNotExist(err) {
			return Capacity{}, err
		}
		parent := filepath.Dir(path)
		if parent == path {
			return Capacity{}, err
		}
		path = parent
	}
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		return Capacity{}, err
	}
	var st syscall.Stat_t
	if err := syscall.Stat(path, &st); err != nil {
		return Capacity{}, err
	}
	return Capacity{Device: uint64(st.Dev), Bytes: uint64(fs.Bavail) * uint64(fs.Bsize), Inodes: uint64(fs.Ffree), InodesKnown: fs.Files > 0}, nil
}

func inspect(ctx context.Context, path string) (Capacity, error) {
	if probe, ok := ctx.Value(probeKey{}).(Probe); ok {
		return probe(path)
	}
	return Inspect(path)
}

// Error keeps the actionable cause before any verbose subprocess output.
type Error struct {
	Component, Path                            string
	Free, Required, FreeInodes, RequiredInodes uint64
	Cleanup                                    string
	InodesKnown                                bool
}

func (e *Error) Error() string {
	s := fmt.Sprintf("%s: insufficient space at %s: need %d MiB, available %d MiB; inodes need %d, available %d", e.Component, e.Path, (e.Required-1)/MiB+1, e.Free/MiB, e.RequiredInodes, e.FreeInodes)
	if e.Cleanup != "" {
		s += "; cleanup: " + e.Cleanup
	}
	return s
}

// MeasurementError distinguishes an unmeasurable path from an installer failure;
// neither a second installation backend nor cleanup can repair an unknown budget.
type MeasurementError struct {
	Component, Path string
	Err             error
}

func (e *MeasurementError) Error() string {
	return fmt.Sprintf("%s: cannot measure install space at %s: %v", e.Component, e.Path, e.Err)
}
func (e *MeasurementError) Unwrap() error { return e.Err }
func StopsFallback(err error) bool {
	var measurement *MeasurementError
	return IsCapacity(err) || errors.As(err, &measurement)
}

func Check(ctx context.Context, component string, needs ...Need) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	type budget struct {
		path          string
		cap           Capacity
		bytes, inodes uint64
	}
	groups := make(map[uint64]*budget)
	var order []uint64
	for _, n := range needs {
		if n.Path == "" {
			return &MeasurementError{Component: component, Err: errors.New("empty install path")}
		}
		c, err := inspect(ctx, n.Path)
		if err != nil {
			return &MeasurementError{Component: component, Path: n.Path, Err: err}
		}
		g := groups[c.Device]
		if g == nil {
			g = &budget{path: n.Path, cap: c}
			groups[c.Device] = g
			order = append(order, c.Device)
		}
		if c.Bytes < g.cap.Bytes {
			g.cap.Bytes = c.Bytes
		}
		if c.Inodes < g.cap.Inodes {
			g.cap.Inodes = c.Inodes
		}
		if ^uint64(0)-g.bytes < n.Bytes || ^uint64(0)-g.inodes < n.Inodes {
			return fmt.Errorf("%s: install size overflow", component)
		}
		g.bytes += n.Bytes
		g.inodes += n.Inodes
	}
	for _, dev := range order {
		g := groups[dev]
		reserve := g.bytes / 10
		if reserve < 128*MiB {
			reserve = 128 * MiB
		}
		if ^uint64(0)-g.bytes < reserve {
			return fmt.Errorf("%s: install size overflow", component)
		}
		required := g.bytes + reserve
		if g.cap.Bytes < required || (g.cap.InodesKnown && g.cap.Inodes < g.inodes) {
			return &Error{Component: component, Path: g.path, Free: g.cap.Bytes, Required: required, FreeInodes: g.cap.Inodes, RequiredInodes: g.inodes, InodesKnown: g.cap.InodesKnown}
		}
	}
	return nil
}

// Ensure attempts only the supplied ownership-aware cleanup, once, on shortage.
func Ensure(ctx context.Context, component string, cleanup func() error, needs ...Need) error {
	err := Check(ctx, component, needs...)
	var shortage *Error
	if !errors.As(err, &shortage) {
		return err
	}
	outcome := "no eligible owned artifacts"
	if cleanup != nil {
		outcome = "attempted; insufficient space remains"
		if e := cleanup(); e != nil {
			outcome = "failed: " + e.Error()
		}
	}
	err = Check(ctx, component, needs...)
	if errors.As(err, &shortage) {
		shortage.Cleanup = outcome
	}
	return err
}

// Lock must precede engine/target locks. Nested installers propagate the returned
// context rather than reacquiring the same flock. No lock is held across exec.
func Lock(ctx context.Context) (context.Context, func(), error) {
	if err := ctx.Err(); err != nil {
		return ctx, nil, err
	}
	if ctx.Value(leaseKey{}) != nil {
		return ctx, func() {}, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ctx, nil, err
	}
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err = ctx.Err(); err != nil {
			return ctx, nil, err
		}
		lock, e := ipc.TryAcquireExclusivePath(filepath.Join(home, ".cxx", "install-space.lock"))
		if e == nil {
			return context.WithValue(ctx, leaseKey{}, true), func() { _ = lock.Release() }, nil
		}
		if !errors.Is(e, ipc.ErrHeld) {
			return ctx, nil, fmt.Errorf("installer space lock: %w", e)
		}
		select {
		case <-ctx.Done():
			return ctx, nil, ctx.Err()
		case <-ticker.C:
		}
	}
}

func Size(size int64, fallback uint64) uint64 {
	if size > 0 {
		return uint64(size)
	}
	return fallback
}

// NpmCache asks npm itself, honoring environment and user/project configuration.
func NpmCache(ctx context.Context, npm, dir string) (string, error) {
	cmd := exec.CommandContext(ctx, npm, "config", "get", "cache")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", &MeasurementError{Component: "npm cache", Path: dir, Err: err}
	}
	path := strings.TrimSpace(string(out))
	if path == "" || !filepath.IsAbs(path) {
		return "", &MeasurementError{Component: "npm cache", Path: dir, Err: errors.New("npm returned an invalid cache directory")}
	}
	return path, nil
}

func IsCapacity(err error) bool {
	var shortage *Error
	return errors.As(err, &shortage) || errors.Is(err, syscall.ENOSPC) || (err != nil && (strings.Contains(strings.ToUpper(err.Error()), "ENOSPC") || strings.Contains(strings.ToLower(err.Error()), "no space left on device")))
}

func WriteError(component, path string, err error) error {
	if !IsCapacity(err) {
		return err
	}
	var shortage *Error
	if errors.As(err, &shortage) {
		return err
	}
	return fmt.Errorf("%s: no space left while writing %s; installation could not complete: %w", component, path, err)
}

// CheckNpmGlobal also measures the effective privileged npm paths before a
// legacy sudo retry; command is either npm or sudo -n npm, never shell text.
func CheckNpmGlobal(ctx context.Context, command []string) error {
	query := func(args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, command[0], append(append([]string{}, command[1:]...), args...)...)
		out, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("resolve npm write directory: %w", err)
		}
		path := strings.TrimSpace(string(out))
		if !filepath.IsAbs(path) {
			return "", errors.New("npm returned an invalid write directory")
		}
		return path, nil
	}
	prefix, err := query("prefix", "-g")
	if err != nil {
		return err
	}
	cache, err := query("config", "get", "cache")
	if err != nil {
		return err
	}
	return Ensure(ctx, "npm global install", nil,
		Need{Path: prefix, Bytes: Package, Inodes: 10000},
		Need{Path: cache, Bytes: Native, Inodes: 10000},
		Need{Path: os.TempDir(), Bytes: Wrapper, Inodes: 128})
}

func (e *Error) Diagnostic() (string, []string) {
	details := []string{fmt.Sprintf("Location: %s", e.Path), fmt.Sprintf("Space required: %d MiB; available: %d MiB", (e.Required-1)/MiB+1, e.Free/MiB)}
	if e.InodesKnown && e.RequiredInodes > 0 && e.FreeInodes < e.RequiredInodes {
		details = append(details, fmt.Sprintf("File entries (inodes) required: %d; available: %d", e.RequiredInodes, e.FreeInodes))
	}
	if e.Cleanup != "" {
		details = append(details, "Safe cleanup: "+e.Cleanup)
	}
	return "Not enough space to install the update", append(details, "Free space or unused file entries on this filesystem, then retry: cxx cron run")
}
func (e *MeasurementError) Diagnostic() (string, []string) {
	return "Cannot check installation space", []string{"Location: " + e.Path, e.Err.Error(), "Check access to this path before retrying the installation."}
}
