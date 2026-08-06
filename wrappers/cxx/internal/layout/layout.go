// Package layout owns the one physical cxx wrapper artifact and its cdx/clx
// multicall aliases. Engine config/auth/state remain outside this package.
package layout

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	EngineCodex  = "codex"
	EngineClaude = "claude"
	lockPrefix   = "cxx-layout-"
)

// Lock serializes cross-engine artifact, alias, and cron layout mutations.
// Per-engine run/auth locks remain separate and intentionally do not use it.
type Lock struct {
	f *os.File
}

func Acquire(ctx context.Context) (*Lock, error) {
	return AcquireForTarget(ctx, "cxx-global")
}

// AcquireForTarget keys coordination to the canonical cxx destination. Root
// cron and unprivileged interactive updates therefore share a lock without
// unnecessarily serializing unrelated custom BIN_DIR installations.
func AcquireForTarget(ctx context.Context, target string) (*Lock, error) {
	path := lockPathForTarget(target)
	f, created, err := openSharedLock(path)
	if err != nil {
		return nil, fmt.Errorf("open cxx layout lock: %w", err)
	}
	if created {
		// OpenFile's creation mode is filtered by umask; explicitly widen the
		// creator-owned inode so a later process under another UID can read-open
		// and flock it. No data is trusted from this world-readable file.
		if err := f.Chmod(0o666); err != nil {
			_ = f.Close()
			return nil, fmt.Errorf("set shared cxx lock mode: %w", err)
		}
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o004 == 0 {
		_ = f.Close()
		return nil, fmt.Errorf("unsafe cxx layout lock %s", path)
	}
	for {
		err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return &Lock{f: f}, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			_ = f.Close()
			return nil, fmt.Errorf("acquire cxx layout lock: %w", err)
		}
		select {
		case <-ctx.Done():
			_ = f.Close()
			return nil, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}

func openSharedLock(path string) (*os.File, bool, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0o666)
	if err == nil {
		return f, true, nil
	}
	if !errors.Is(err, os.ErrExist) {
		return nil, false, err
	}
	f, err = os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	return f, false, err
}

func lockPathForTarget(target string) string {
	abs, err := filepath.Abs(target)
	if err == nil {
		target = filepath.Clean(abs)
	}
	sum := sha256.Sum256([]byte(target))
	return filepath.Join(os.TempDir(), lockPrefix+hex.EncodeToString(sum[:12])+".lock")
}

func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	err := syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	err = errors.Join(err, l.f.Close())
	l.f = nil
	return err
}

// WithLock runs fn while holding the fleet wrapper's cross-engine mutation
// lock. Downloads may happen before entering this section; installs may not.
func WithLock(ctx context.Context, fn func() error) error {
	return WithTargetLock(ctx, "cxx-global", fn)
}

func WithTargetLock(ctx context.Context, target string, fn func() error) error {
	lock, err := AcquireForTarget(ctx, target)
	if err != nil {
		return err
	}
	defer lock.Release()
	return fn()
}

// EnsureAliases materializes cxx beside the running combined binary when
// needed, then atomically points aliases for the supplied enabled engines at
// the relative target "cxx". It never removes aliases: stale/offline state is
// allowed to add nothing, but cannot disable an engine.
func EnsureAliases(ctx context.Context, executable string, engines []string) (string, error) {
	return EnsureAliasesForSHA(ctx, executable, engines, "")
}

// EnsureAliasesForSHA additionally requires either the existing cxx or the
// running combined binary to match expectedSHA before replacing aliases. This
// prevents an older sibling cxx from winning during first-run migration.
func EnsureAliasesForSHA(ctx context.Context, executable string, engines []string, expectedSHA string) (string, error) {
	var canonical string
	target, err := canonicalTarget(executable)
	if err != nil {
		return "", err
	}
	err = WithTargetLock(ctx, target, func() error {
		var err error
		canonical, err = ensureCanonical(executable, expectedSHA)
		if err != nil {
			return err
		}
		for _, engine := range normalizeEngines(engines) {
			if err := ensureAlias(filepath.Dir(canonical), aliasForEngine(engine)); err != nil {
				return err
			}
		}
		return nil
	})
	return canonical, err
}

// CanonicalExecutable returns the cxx target when it exists beside a legacy
// regular cdx/clx path, otherwise the resolved running executable. This keeps
// self-update from replacing a multicall symlink with a regular file.
func CanonicalExecutable(executable string) (string, error) {
	if strings.TrimSpace(executable) == "" {
		return "", errors.New("empty executable path")
	}
	abs, err := filepath.Abs(executable)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err == nil && filepath.Base(resolved) == "cxx" {
		return resolved, nil
	}
	dir := filepath.Dir(abs)
	if resolved != "" {
		dir = filepath.Dir(resolved)
	}
	candidate := filepath.Join(dir, "cxx")
	// A legacy regular cdx/clx is already the combined executable. Its update
	// destination is always the sibling cxx even on the first migration when
	// that sibling does not exist yet.
	if base := filepath.Base(resolved); base == "cdx" || base == "clx" {
		return candidate, nil
	}
	if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
		return candidate, nil
	}
	if err != nil {
		return "", fmt.Errorf("resolve executable: %w", err)
	}
	return resolved, nil
}

// ReexecArgv preserves persona identity whenever the executable's canonical
// update destination is cxx, including first-run migration from a regular
// cdx/clx binary.
//
// An empty engine selects the host form (`cxx <argv...>`) instead. A
// cxx-dispatched second pass needs it: `cxx update` authenticates through one
// persona but must hand the follow-up work to the host-level command so it
// reaches every installed engine, not just the one that ran the install.
func ReexecArgv(executable, engine string, argv []string) []string {
	full := []string{executable}
	resolved, err := CanonicalExecutable(executable)
	if err == nil && engine != "" && filepath.Base(resolved) == "cxx" {
		full = append(full, engine)
	}
	return append(full, argv...)
}

// RemoveAlias removes only a managed relative alias to cxx. A regular legacy
// binary or an unrelated symlink is left untouched.
func RemoveAlias(ctx context.Context, dir, engine string) error {
	return WithTargetLock(ctx, filepath.Join(dir, "cxx"), func() error {
		alias := filepath.Join(dir, aliasForEngine(engine))
		target, err := os.Readlink(alias)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil || target != "cxx" {
			return nil
		}
		if err := os.Remove(alias); err == nil || errors.Is(err, os.ErrNotExist) {
			return nil
		} else {
			return sudoRemove(alias, err)
		}
	})
}

// RemoveShared removes both managed aliases followed by the canonical cxx
// artifact. Callers must use this only after the server has confirmed that no
// engine remains; uncertainty must preserve every shared artifact.
func RemoveShared(ctx context.Context, executable string) error {
	target, err := canonicalTarget(executable)
	if err != nil {
		return err
	}
	return WithTargetLock(ctx, target, func() error {
		legacyRegular := ""
		if abs, absErr := filepath.Abs(executable); absErr == nil {
			if info, statErr := os.Lstat(abs); statErr == nil && info.Mode().IsRegular() &&
				(filepath.Base(abs) == "cdx" || filepath.Base(abs) == "clx") {
				// The current process proves this regular persona-named inode is the
				// combined dispatcher. Remember it for last-engine cleanup when first
				// run alias migration could not complete.
				legacyRegular = abs
			}
		}
		canonical, err := CanonicalExecutable(executable)
		if err != nil {
			return err
		}
		dir := filepath.Dir(canonical)
		var errs []error
		for _, engine := range []string{EngineCodex, EngineClaude} {
			alias := filepath.Join(dir, aliasForEngine(engine))
			target, readErr := os.Readlink(alias)
			if readErr == nil && target == "cxx" {
				if removeErr := removeFile(alias); removeErr != nil {
					errs = append(errs, removeErr)
				}
			}
		}
		if filepath.Base(canonical) == "cxx" {
			if removeErr := removeFile(canonical); removeErr != nil {
				errs = append(errs, removeErr)
			}
		}
		if legacyRegular != "" {
			if removeErr := removeFile(legacyRegular); removeErr != nil {
				errs = append(errs, removeErr)
			}
		}
		return errors.Join(errs...)
	})
}

func canonicalTarget(executable string) (string, error) {
	if strings.TrimSpace(executable) == "" {
		return "", errors.New("empty executable path")
	}
	abs, err := filepath.Abs(executable)
	if err != nil {
		return "", err
	}
	resolved, resolveErr := filepath.EvalSymlinks(abs)
	if resolveErr == nil && filepath.Base(resolved) == "cxx" {
		return resolved, nil
	}
	return filepath.Join(filepath.Dir(abs), "cxx"), nil
}

func removeFile(path string) error {
	if err := os.Remove(path); err == nil || errors.Is(err, os.ErrNotExist) {
		return nil
	} else {
		return sudoRemove(path, err)
	}
}

func ensureCanonical(executable, expectedSHA string) (string, error) {
	if strings.TrimSpace(executable) == "" {
		return "", errors.New("empty executable path")
	}
	abs, err := filepath.Abs(executable)
	if err != nil {
		return "", err
	}
	resolved, resolveErr := filepath.EvalSymlinks(abs)
	if resolveErr == nil && filepath.Base(resolved) == "cxx" {
		if strings.TrimSpace(expectedSHA) != "" && !fileSHA256Matches(resolved, expectedSHA) {
			return "", fmt.Errorf("canonical cxx does not match expected sha256 %s", expectedSHA)
		}
		return resolved, nil
	}
	if resolveErr != nil && !errors.Is(resolveErr, os.ErrNotExist) {
		return "", fmt.Errorf("resolve executable: %w", resolveErr)
	}
	source := resolved
	if source == "" {
		source = abs
	}
	canonical := filepath.Join(filepath.Dir(abs), "cxx")
	legacyPersona := filepath.Base(resolved) == "cdx" || filepath.Base(resolved) == "clx"
	if legacyPersona {
		// Reaching this code proves the regular cdx/clx inode contains the
		// combined dispatcher. Prefer those executing bytes over an unrelated or
		// stale sibling cxx. With a signed checksum, an already-current sibling
		// may still win during a rolling update where the running bytes lag.
		if strings.TrimSpace(expectedSHA) != "" && !fileSHA256Matches(source, expectedSHA) {
			if fileSHA256Matches(canonical, expectedSHA) {
				return canonical, nil
			}
			return "", fmt.Errorf("neither existing cxx nor running wrapper matches expected sha256 %s", expectedSHA)
		}
		if err := InstallAtomic(source, canonical); err != nil {
			return "", fmt.Errorf("materialize %s from running wrapper: %w", canonical, err)
		}
		return canonical, nil
	}
	if info, statErr := os.Stat(canonical); statErr == nil {
		if info.IsDir() {
			return "", fmt.Errorf("canonical wrapper path %s is a directory", canonical)
		}
		if strings.TrimSpace(expectedSHA) == "" || fileSHA256Matches(canonical, expectedSHA) {
			return canonical, nil
		}
		if !fileSHA256Matches(source, expectedSHA) {
			return "", fmt.Errorf("neither existing cxx nor running wrapper matches expected sha256 %s", expectedSHA)
		}
		if err := InstallAtomic(source, canonical); err != nil {
			return "", fmt.Errorf("replace stale %s: %w", canonical, err)
		}
		return canonical, nil
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return "", statErr
	}
	if strings.TrimSpace(expectedSHA) != "" && !fileSHA256Matches(source, expectedSHA) {
		return "", fmt.Errorf("running wrapper does not match expected sha256 %s", expectedSHA)
	}
	if err := InstallAtomic(source, canonical); err != nil {
		return "", fmt.Errorf("materialize %s: %w", canonical, err)
	}
	return canonical, nil
}

func fileSHA256Matches(path, expected string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false
	}
	return strings.EqualFold(hex.EncodeToString(h.Sum(nil)), strings.TrimSpace(expected))
}

func ensureAlias(dir, name string) error {
	alias := filepath.Join(dir, name)
	if info, err := os.Lstat(alias); err == nil {
		if info.IsDir() {
			return fmt.Errorf("wrapper alias path %s is a directory", alias)
		}
		if target, readErr := os.Readlink(alias); readErr == nil && target == "cxx" {
			return nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	tmp := filepath.Join(dir, "."+name+".cxx-link-"+strconv.Itoa(os.Getpid()))
	_ = os.Remove(tmp)
	if err := os.Symlink("cxx", tmp); err != nil {
		return sudoAlias(alias, err)
	}
	if err := os.Rename(tmp, alias); err != nil {
		_ = os.Remove(tmp)
		return sudoAlias(alias, err)
	}
	return nil
}

// InstallAtomic copies source to a same-directory temporary file and renames
// it over dest. Its privileged fallback follows the same stage-and-rename
// protocol; it never truncates the live wrapper in place.
func InstallAtomic(source, dest string) error {
	if info, err := os.Lstat(dest); err == nil && info.IsDir() {
		return fmt.Errorf("wrapper destination %s is a directory", dest)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.CreateTemp(filepath.Dir(dest), ".cxx-*.new")
	if err != nil {
		return sudoInstall(source, dest, err)
	}
	tmp := out.Name()
	defer os.Remove(tmp)
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmp, dest); err != nil {
		return sudoInstall(source, dest, err)
	}
	return nil
}

func normalizeEngines(engines []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, 2)
	for _, engine := range engines {
		engine = strings.ToLower(strings.TrimSpace(engine))
		if (engine == EngineCodex || engine == EngineClaude) && !seen[engine] {
			seen[engine] = true
			out = append(out, engine)
		}
	}
	return out
}

func aliasForEngine(engine string) string {
	if strings.EqualFold(strings.TrimSpace(engine), EngineClaude) {
		return "clx"
	}
	return "cdx"
}

func sudoInstall(source, dest string, cause error) error {
	if _, err := exec.LookPath("sudo"); err != nil {
		return cause
	}
	tmp, err := privilegedTempPath(dest, "new")
	if err != nil {
		return fmt.Errorf("%v; allocate sudo staging path: %w", cause, err)
	}
	out, err := runSudo("install", "-m", "0755", source, tmp)
	if err != nil {
		return fmt.Errorf("%v; sudo install failed: %w: %s", cause, err, strings.TrimSpace(string(out)))
	}
	defer runSudo("rm", "-f", tmp) // best-effort cleanup after a failed move
	out, err = runSudo("mv", "-f", tmp, dest)
	if err != nil {
		return fmt.Errorf("%v; sudo atomic move failed: %w: %s", cause, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func sudoAlias(alias string, cause error) error {
	if _, err := exec.LookPath("sudo"); err != nil {
		return cause
	}
	if info, err := os.Lstat(alias); err == nil && info.IsDir() {
		return fmt.Errorf("wrapper alias path %s is a directory", alias)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	tmp, err := privilegedTempPath(alias, "link")
	if err != nil {
		return fmt.Errorf("%v; allocate sudo alias staging path: %w", cause, err)
	}
	out, err := runSudo("ln", "-s", "cxx", tmp)
	if err != nil {
		return fmt.Errorf("%v; sudo alias failed: %w: %s", cause, err, strings.TrimSpace(string(out)))
	}
	defer runSudo("rm", "-f", tmp)
	mvArgs := []string{"mv", "-f"}
	if runtime.GOOS == "linux" {
		mvArgs = append(mvArgs, "-T")
	}
	mvArgs = append(mvArgs, tmp, alias)
	out, err = runSudo(mvArgs...)
	if err != nil {
		return fmt.Errorf("%v; sudo atomic alias move failed: %w: %s", cause, err, strings.TrimSpace(string(out)))
	}
	return nil
}

var runSudo = func(args ...string) ([]byte, error) {
	return exec.Command("sudo", append([]string{"-n"}, args...)...).CombinedOutput()
}

func privilegedTempPath(dest, kind string) (string, error) {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(dest), "."+filepath.Base(dest)+".cxx-"+kind+"-"+hex.EncodeToString(nonce[:])), nil
}

func sudoRemove(path string, cause error) error {
	if _, err := exec.LookPath("sudo"); err != nil {
		return cause
	}
	out, err := exec.Command("sudo", "-n", "rm", "-f", path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v; sudo remove failed: %w: %s", cause, err, strings.TrimSpace(string(out)))
	}
	return nil
}
