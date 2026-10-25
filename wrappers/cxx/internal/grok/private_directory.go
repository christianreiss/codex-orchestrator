package grok

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

const PrivateReaperCommand = "__cxx-grok-private-reaper"
const privateLeaseName = ".cxx-private-lease"

// PrivateDirectory starts an independent cleaner before any credentials are
// written. The cleaner owns no secret and survives the launcher being killed.
type PrivateDirectory struct {
	Dir      string
	lease    *ipc.Lock
	done     chan error
	once     sync.Once
	closeErr error
}

func GuardPrivateDirectory(dir string, lifetimeLeases ...*ipc.Lock) (*PrivateDirectory, error) {
	lease, err := ipc.TryAcquireSharedPath(filepath.Join(dir, privateLeaseName))
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*PrivateDirectory, error) {
		_ = lease.Release()
		_ = os.RemoveAll(dir)
		return nil, err
	}
	// A separate open-file description must wait for the shared holders. A dup
	// of lease would silently upgrade that same description instead of waiting.
	waiter, err := os.OpenFile(filepath.Join(dir, privateLeaseName), os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return fail(err)
	}
	defer waiter.Close()
	ackRead, ackWrite, err := os.Pipe()
	if err != nil {
		return fail(err)
	}
	defer ackRead.Close()
	defer ackWrite.Close()
	exe, err := os.Executable()
	if err != nil {
		return fail(err)
	}
	cmd := exec.Command(exe, PrivateReaperCommand, dir)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Env = []string{"PATH=" + os.Getenv("PATH")}
	cmd.ExtraFiles = []*os.File{waiter, ackWrite}
	var duplicates []*ipc.ExecLease
	defer func() {
		for _, dup := range duplicates {
			_ = dup.Release()
		}
	}()
	for _, held := range lifetimeLeases {
		if held == nil {
			continue
		}
		dup, err := held.DuplicateForExec()
		if err != nil {
			return fail(err)
		}
		duplicates = append(duplicates, dup)
		cmd.ExtraFiles = append(cmd.ExtraFiles, dup.File())
	}
	if err := cmd.Start(); err != nil {
		return fail(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	_ = ackWrite.Close()
	_ = ackRead.SetReadDeadline(time.Now().Add(10 * time.Second))
	var ready [1]byte
	if _, err := io.ReadFull(ackRead, ready[:]); err != nil || ready[0] != 1 {
		_ = cmd.Process.Kill()
		<-done
		return fail(errors.New("Grok private cleanup helper did not become ready"))
	}
	return &PrivateDirectory{Dir: dir, lease: lease, done: done}, nil
}

func (p *PrivateDirectory) AttachChild(cmd *exec.Cmd) (func(), error) {
	return p.Attach(cmd)
}

func (p *PrivateDirectory) Attach(cmd *exec.Cmd) (func(), error) {
	dup, err := p.lease.DuplicateForExec()
	if err != nil {
		return nil, err
	}
	cmd.ExtraFiles = append(cmd.ExtraFiles, dup.File())
	return func() { _ = dup.Release() }, nil
}
func (p *PrivateDirectory) Close() error {
	if p == nil {
		return nil
	}
	p.once.Do(func() {
		p.closeErr = p.lease.Release()
		select {
		case err := <-p.done:
			p.closeErr = errors.Join(p.closeErr, err)
		case <-time.After(5 * time.Second):
			p.closeErr = errors.Join(p.closeErr, errors.New("Grok private directory still has an active holder"))
		}
	})
	return p.closeErr
}

// RunPrivateReaper accepts only the actual inherited descriptor for an owned
// 0700 directory. No untrusted pathname can substitute a different lock inode.
func RunPrivateReaper(args []string) int {
	if len(args) != 1 {
		return 2
	}
	dir := args[0]
	if !filepath.IsAbs(dir) {
		return 2
	}
	name := filepath.Base(dir)
	if !strings.HasPrefix(name, "session-") && !strings.HasPrefix(name, "cgx-runtime-") && !strings.HasPrefix(name, "cgx-login-") {
		return 2
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return 2
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		return 2
	}
	lock := os.NewFile(3, "private-cleanup-lock")
	if lock == nil {
		return 2
	}
	defer lock.Close()
	held, err := lock.Stat()
	if err != nil {
		return 2
	}
	expected, err := os.Lstat(filepath.Join(dir, privateLeaseName))
	if err != nil || !os.SameFile(held, expected) {
		return 2
	}
	ack := os.NewFile(4, "private-cleanup-ready")
	if ack == nil {
		return 2
	}
	if _, err := ack.Write([]byte{1}); err != nil {
		return 2
	}
	_ = ack.Close()
	for {
		err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX)
		if !errors.Is(err, syscall.EINTR) {
			break
		}
	}
	if err != nil {
		return 1
	}
	// Some native programs close inherited descriptors. Their private home in
	// the process environment is an independent conservative liveness fence.
	waitPrivateDirectoryIdle(dir)
	if err := os.RemoveAll(dir); err != nil {
		fmt.Fprintln(os.Stderr, "Grok private cleanup failed")
		return 1
	}
	return 0
}

// SweepPrivateDirectories recovers owned leftovers after a helper/host crash.
// It never uses age as proof: both the private lock and process fence must be idle.
func SweepPrivateDirectories() error {
	state, err := StateDir()
	if err != nil {
		return err
	}
	roots := map[string][]string{filepath.Join(state, "runtimes"): {"session-"}, os.TempDir(): {"cgx-runtime-", "cgx-login-"}}
	var result error
	for root, prefixes := range roots {
		entries, err := os.ReadDir(root)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			result = errors.Join(result, err)
			continue
		}
		for _, entry := range entries {
			matches := false
			for _, prefix := range prefixes {
				matches = matches || strings.HasPrefix(entry.Name(), prefix)
			}
			if !matches {
				continue
			}
			dir := filepath.Join(root, entry.Name())
			info, err := os.Lstat(dir)
			if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
				continue
			}
			stat, ok := info.Sys().(*syscall.Stat_t)
			if !ok || stat.Uid != uint32(os.Getuid()) {
				continue
			}
			// Only the new guard's marker authorizes cleanup, never arbitrary temp files.
			marker := filepath.Join(dir, privateLeaseName)
			info, err = os.Lstat(marker)
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			lock, err := ipc.TryAcquireExclusivePath(marker)
			if errors.Is(err, ipc.ErrHeld) {
				continue
			}
			if err != nil {
				result = errors.Join(result, err)
				continue
			}
			if !privateDirectoryInUse(dir) {
				result = errors.Join(result, os.RemoveAll(dir))
			}
			_ = lock.Release()
		}
	}
	return result
}
