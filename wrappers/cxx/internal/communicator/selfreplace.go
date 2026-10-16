package communicator

import (
	"fmt"
	"os"
	"runtime"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentquiet"
)

// executableImage identifies the binary an owner runs and the path it was
// started from. `cxx update` (cron, explicit or the updater) installs by
// atomic rename, so after an update the path names a different file while the
// process keeps running the deleted old image. Streaming leases from a
// persistent host daemon or agent worker would otherwise keep that owner alive
// indefinitely: the idle exit never fires while a lease is open.
type executableImage struct {
	path    string
	running os.FileInfo
}

// currentExecutable captures the running image. On Linux /proc/self/exe
// resolves to the inode actually executing, even when it was already replaced
// before this point; elsewhere the path is stat'ed right after exec.
var currentExecutable = func() *executableImage {
	path, err := os.Executable()
	if err != nil || path == "" {
		return nil
	}
	var running os.FileInfo
	if runtime.GOOS == "linux" {
		running, err = os.Stat("/proc/self/exe")
	} else {
		running, err = os.Stat(path)
	}
	if err != nil {
		return nil
	}
	return &executableImage{path: path, running: running}
}

// replaced reports whether the start path now names a different file. A
// missing path (an install mid-removal) is not a replacement: nothing could
// start a successor from it.
func (i *executableImage) replaced() bool {
	if i == nil || i.running == nil {
		return false
	}
	info, err := os.Stat(i.path)
	if err != nil {
		return false
	}
	return !os.SameFile(i.running, info)
}

// nativeAgentsQuiet is the updater's quiet gate. Its probe briefly takes each
// engine's exclusive housekeeping lock, so it runs only once a replacement is
// seen and at most every replacedQuietProbe.
var nativeAgentsQuiet = func() bool { return len(agentquiet.Busy()) == 0 }

const replacedQuietProbe = 30 * time.Second

// retireIfReplaced drains and ends an on-demand owner whose executable was
// replaced, once it has no finite work in flight and no native agent runs.
// Lease holders (native launches, the agent worker, the host daemon) redial
// and start the installed binary, as they do after any owner exit; a request
// refused while draining is a definitive "not sent" that callers retry.
// Residents are replaced by the root handoff instead. It returns true when
// the owner was told to stop.
func (s *server) retireIfReplaced(cancel func()) bool {
	if s.image == nil || s.resident.Load() || s.draining.Load() || s.terminating.Load() {
		return false
	}
	if !s.exeReplaced.Load() {
		if !s.image.replaced() {
			return false
		}
		s.exeReplaced.Store(true)
	}
	busy := func() bool {
		s.mu.Lock()
		calls := len(s.calls)
		s.mu.Unlock()
		return calls > 0 || ownerUpdaterEnv{s: s}.Busy() > 0
	}
	if busy() {
		return false
	}
	now := time.Now()
	s.mu.Lock()
	due := now.Sub(s.replacedProbedAt) >= replacedQuietProbe
	if due {
		s.replacedProbedAt = now
	}
	s.mu.Unlock()
	if !due || !nativeAgentsQuiet() {
		return false
	}
	// Single-shot with a remote terminate. Admission closes first; work that
	// slipped in before gets the same bounded drain a terminate grants.
	if !s.terminating.CompareAndSwap(false, true) {
		return false
	}
	s.draining.Store(true)
	for deadline := time.Now().Add(terminateDrain); busy() && time.Now().Before(deadline); {
		time.Sleep(50 * time.Millisecond)
	}
	fmt.Fprintf(os.Stderr, "communicator: executable %s was replaced; retiring so the installed binary takes over\n", s.image.path)
	cancel()
	return true
}
