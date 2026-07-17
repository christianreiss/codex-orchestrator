package claude

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
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
func attachAuthLeaseFiles(cmd *exec.Cmd, session *AuthSession, child *authChildLease) (func(), error) {
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
	lease, err := acquireAuthChildShared()
	if err != nil {
		return 1, err
	}
	if len(argv) == 0 {
		_ = lease.Close()
		return 1, errors.New("Claude help argv is empty")
	}
	cmd := exec.CommandContext(ctx, path, argv[1:]...)
	cmd.Env = env
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	closeExtras, err := attachAuthLeaseFiles(cmd, session, lease)
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

	sigCh := make(chan os.Signal, 4)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for sig := range sigCh {
			if cmd.Process != nil {
				_ = cmd.Process.Signal(sig)
			}
		}
	}()

	waitErr := cmd.Wait()
	leaseErr := lease.Close()
	signal.Stop(sigCh)
	close(sigCh)
	<-done
	if waitErr == nil && leaseErr != nil {
		return 1, fmt.Errorf("release Claude help auth child lease: %w", leaseErr)
	}
	if waitErr == nil {
		return 0, nil
	}
	if exitErr, ok := waitErr.(*exec.ExitError); ok {
		return exitErr.ExitCode(), nil
	}
	return 1, waitErr
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

func (l *authChildLease) Close() error {
	if l == nil || l.f == nil {
		return nil
	}
	f := l.f
	l.f = nil
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return f.Close()
}
