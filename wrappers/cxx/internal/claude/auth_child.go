package claude

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeprocess"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/sessionguard"
)

// ErrAuthChildActive means a clx-launched Claude process is actively using the
// native credential path. Conditional canonical writes treat it as a safe
// skip; destructive explicit operations surface it to the caller.
var ErrAuthChildActive = errors.New("active Claude child is using native credentials")

type authChildLease struct {
	f *os.File
}

func duplicateLeaseFile(f *os.File, name string) (*os.File, error) {
	if f == nil {
		return nil, fmt.Errorf("%s lease is closed", name)
	}
	fd, err := syscall.Dup(int(f.Fd()))
	if err != nil {
		return nil, fmt.Errorf("duplicate %s lease: %w", name, err)
	}
	return os.NewFile(uintptr(fd), name), nil
}

// attachAuthLeaseFiles gives the native CLI duplicate descriptors for both
// coordination leases. flock ownership then survives a SIGKILL of the wrapper:
// the orphaned Claude process remains the last holder until it actually exits.
func attachAuthLeaseFiles(cmd *exec.Cmd, session *AuthSession, child *authChildLease, extraLeases ...*ipc.Lock) (func(), error) {
	files := make([]*os.File, 0, 2)
	closeFiles := func() {
		for _, f := range files {
			_ = f.Close()
		}
	}
	if session != nil {
		session.mu.Lock()
		if session.f == nil {
			session.mu.Unlock()
			return closeFiles, errors.New("Claude auth session already closed before child start")
		}
		dup, err := duplicateLeaseFile(session.f, "clx-auth-session-child")
		session.mu.Unlock()
		if err != nil {
			return closeFiles, err
		}
		files = append(files, dup)
	}
	if child != nil {
		dup, err := duplicateLeaseFile(child.f, "clx-auth-active-child")
		if err != nil {
			closeFiles()
			return func() {}, err
		}
		files = append(files, dup)
	}
	for _, lease := range extraLeases {
		dup, err := lease.DuplicateForExec()
		if err != nil {
			closeFiles()
			return func() {}, err
		}
		files = append(files, dup.File())
	}
	cmd.ExtraFiles = append(cmd.ExtraFiles, files...)
	return closeFiles, nil
}

func runCommandWithAuthChildLease(cmd *exec.Cmd) error {
	lease, err := acquireAuthChildShared()
	if err != nil {
		return err
	}
	closeExtras, err := attachAuthLeaseFiles(cmd, nil, lease)
	if err != nil {
		_ = lease.Close()
		return err
	}
	if err := cmd.Start(); err != nil {
		closeExtras()
		_ = lease.Close()
		return err
	}
	closeExtras()
	waitErr := cmd.Wait()
	closeErr := lease.Close()
	if waitErr != nil {
		return waitErr
	}
	return closeErr
}

// RunHelpPassthrough keeps the wrapper frame alive around upstream help so it
// can finalize a shared auth session after the child exits. It otherwise
// preserves passthrough behavior: exact argv/env/stdin/stdout/stderr, forwarded
// terminal signals, and the upstream exit status.
func RunHelpPassthrough(
	ctx context.Context,
	path string,
	argv, env []string,
	stdin io.Reader,
	stdout, stderr io.Writer,
	session *AuthSession,
) (int, error) {
	guard, err := sessionguard.Launch("claude")
	if err != nil {
		return 1, err
	}
	defer guard.Release()
	lease, err := acquireAuthChildShared()
	if err != nil {
		return 1, err
	}
	if len(argv) == 0 {
		_ = lease.Close()
		return 1, errors.New("Claude help argv is empty")
	}
	cmd := exec.CommandContext(ctx, path, argv[1:]...)
	cmd.Env = managedClaudeEnv(path, env)
	cmd.Stdin = stdin
	supervisor := nativeprocess.Prepare(ctx, cmd, nativeprocess.Headless(cmd.Stdin))
	defer supervisor.Close()
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	closeExtras, err := attachAuthLeaseFiles(cmd, session, lease, guard)
	if err != nil {
		_ = lease.Close()
		return 1, err
	}
	if err := cmd.Start(); err != nil {
		closeExtras()
		_ = lease.Close()
		return 127, fmt.Errorf("start Claude help: %w", err)
	}
	closeExtras()

	waitErr := cmd.Wait()
	supervisor.Close()
	leaseErr := lease.Close()
	if waitErr == nil && leaseErr != nil {
		return 1, fmt.Errorf("release Claude help auth child lease: %w", leaseErr)
	}
	return supervisor.Result(waitErr)
}

func openAuthChildLease() (*os.File, error) {
	paths, err := authFiles()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(paths.childLease), 0o700); err != nil {
		return nil, err
	}
	return os.OpenFile(paths.childLease, os.O_CREATE|os.O_RDWR, 0o600)
}

// acquireAuthChildShared is taken immediately before starting upstream Claude
// and held through Wait. A writer already at its commit point delays the child;
// once the child is active, writers skip instead of changing auth underneath it.
func acquireAuthChildShared() (*authChildLease, error) {
	f, err := openAuthChildLease()
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_SH); err != nil {
		_ = f.Close()
		return nil, err
	}
	return &authChildLease{f: f}, nil
}

func tryAcquireAuthChildWriter() (*authChildLease, error) {
	f, err := openAuthChildLease()
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, ErrAuthChildActive
		}
		return nil, err
	}
	return &authChildLease{f: f}, nil
}

// HasActiveAuthChild proves a wrapped Claude child still holds its inherited
// shared lease. It does not create files or infer activity from credentials.
func HasActiveAuthChild() (bool, error) {
	paths, err := authFiles()
	if err != nil {
		return false, err
	}
	f, err := os.OpenFile(paths.childLease, os.O_RDWR, 0)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return true, nil
		}
		return false, err
	}
	return false, syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
}

func (l *authChildLease) Close() error {
	if l == nil || l.f == nil {
		return nil
	}
	f := l.f
	l.f = nil
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return f.Close()
}
