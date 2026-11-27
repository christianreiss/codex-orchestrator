// Package privatehome guards the per-session private engine directories that
// carry access-only credential projections (Grok and Kimi runtimes and logins).
// An independent cleaner process is started before any credential is written;
// it owns no secret, survives the launcher being killed, and removes the
// directory once every holder is gone.
//
// The cleaner is re-executed from the installed binary, which may be a newer
// release than the launcher after a self-update. The reaper subcommand names,
// directory prefixes, the lease file name and the fd 3/4 + ack byte protocol
// are therefore a cross-version contract.
package privatehome

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
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/posix"
)

// LeaseName is the shared lease file inside every private directory.
const LeaseName = ".cxx-private-lease"

// Spec is one engine's private-directory contract. Every value is a literal
// the engine owns; nothing is derived from the engine name.
type Spec struct {
	// ReaperCommand is the hidden cxx subcommand that runs RunReaper.
	ReaperCommand string
	// Label names the engine in error text, for example "Grok".
	Label string
	// TempPrefixes are the private directory prefixes under os.TempDir().
	// Directories under <state>/runtimes always use "session-".
	TempPrefixes []string
	// EnvKeys are the environment variables a native process uses to point
	// at its private home; a process carrying one still holds the directory.
	EnvKeys []string
	// StateDir returns the engine state directory holding runtimes/.
	StateDir func() (string, error)
	// Busy is the engine's ErrPrivateDirectoryBusy.
	Busy error
	// BeforeRemove, when set, runs once the directory is idle and before it is
	// removed. An error keeps the directory for a later retry.
	BeforeRemove func(dir string) error
}

// Directory is a guarded private directory.
type Directory struct {
	Dir      string
	lease    *ipc.Lock
	done     chan error
	once     sync.Once
	closeErr error
	busy     error
}

func (s *Spec) recognized(name string) bool {
	if strings.HasPrefix(name, "session-") {
		return true
	}
	for _, prefix := range s.TempPrefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// Guard starts the cleaner for dir before any credentials are written.
func (s *Spec) Guard(dir string, lifetimeLeases ...*ipc.Lock) (*Directory, error) {
	lease, err := ipc.TryAcquireSharedPath(filepath.Join(dir, LeaseName))
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*Directory, error) {
		_ = lease.Release()
		_ = os.RemoveAll(dir)
		return nil, err
	}
	// A separate open-file description must wait for the shared holders. A dup
	// of lease would silently upgrade that same description instead of waiting.
	waiter, err := posix.OpenFile(filepath.Join(dir, LeaseName), os.O_RDWR|posix.O_NOFOLLOW, 0600)
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
	cmd := exec.Command(exe, s.ReaperCommand, dir)
	cmd.SysProcAttr = posix.NewSessionAttr()
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
		return fail(errors.New(s.Label + " private cleanup helper did not become ready"))
	}
	return &Directory{Dir: dir, lease: lease, done: done, busy: s.Busy}, nil
}

func (p *Directory) AttachChild(cmd *exec.Cmd) (func(), error) {
	return p.Attach(cmd)
}

func (p *Directory) Attach(cmd *exec.Cmd) (func(), error) {
	dup, err := p.lease.DuplicateForExec()
	if err != nil {
		return nil, err
	}
	cmd.ExtraFiles = append(cmd.ExtraFiles, dup.File())
	return func() { _ = dup.Release() }, nil
}
func (p *Directory) Close() error {
	if p == nil {
		return nil
	}
	p.once.Do(func() {
		p.closeErr = p.lease.Release()
		select {
		case err := <-p.done:
			p.closeErr = errors.Join(p.closeErr, err)
		case <-time.After(5 * time.Second):
			p.closeErr = errors.Join(p.closeErr, p.busy)
		}
	})
	return p.closeErr
}

// RunReaper accepts only the actual inherited descriptor for an owned 0700
// directory. No untrusted pathname can substitute a different lock inode.
func (s *Spec) RunReaper(args []string) int {
	if len(args) != 1 {
		return 2
	}
	dir := args[0]
	if !filepath.IsAbs(dir) {
		return 2
	}
	if !s.recognized(filepath.Base(dir)) {
		return 2
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return 2
	}
	stat, ok := info.Sys().(*posix.Stat_t)
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
	expected, err := os.Lstat(filepath.Join(dir, LeaseName))
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
		err = posix.Flock(int(lock.Fd()), posix.LOCK_EX)
		if !errors.Is(err, syscall.EINTR) {
			break
		}
	}
	if err != nil {
		return 1
	}
	// Some native programs close inherited descriptors. Their private home in
	// the process environment is an independent conservative liveness fence.
	s.waitIdle(dir)
	if s.BeforeRemove != nil {
		if err := s.BeforeRemove(dir); err != nil {
			return 1
		}
	}
	if err := os.RemoveAll(dir); err != nil {
		fmt.Fprintln(os.Stderr, s.Label+" private cleanup failed")
		return 1
	}
	return 0
}

// Sweep recovers owned leftovers after a helper/host crash. It never uses age
// as proof: both the private lock and process fence must be idle.
func (s *Spec) Sweep() error {
	state, err := s.StateDir()
	if err != nil {
		return err
	}
	roots := map[string][]string{filepath.Join(state, "runtimes"): {"session-"}, os.TempDir(): s.TempPrefixes}
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
			_, err = s.RemoveIdle(dir)
			if err != nil && !errors.Is(err, s.Busy) {
				result = errors.Join(result, err)
			}
		}
	}
	return result
}

// RemoveIdle removes only recognized runtime directories owned by this UID.
// Both maintenance and engine destruction use the same lifetime fence. A
// matching filename alone never authorizes deleting shared temp data.
// Unrecognized paths are left alone; an active owned path returns Busy.
func (s *Spec) RemoveIdle(dir string) (bool, error) {
	if !filepath.IsAbs(dir) || !s.recognized(filepath.Base(dir)) {
		return false, nil
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return false, nil
	}
	stat, ok := info.Sys().(*posix.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		return false, nil
	}
	marker := filepath.Join(dir, LeaseName)
	info, err = os.Lstat(marker)
	if err != nil || !info.Mode().IsRegular() {
		return false, nil
	}
	lock, err := ipc.TryAcquireExclusivePath(marker)
	if errors.Is(err, ipc.ErrHeld) {
		return false, s.Busy
	}
	if err != nil {
		return false, err
	}
	defer lock.Release()
	if s.inUse(dir) {
		return false, s.Busy
	}
	if s.BeforeRemove != nil {
		if err := s.BeforeRemove(dir); err != nil {
			return false, err
		}
	}
	if err := os.RemoveAll(dir); err != nil {
		return false, err
	}
	return true, nil
}
