package grok

import (
	"errors"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/privatehome"
)

// PrivateReaperCommand is re-executed from the installed binary, possibly a
// newer release; keep the name.
const PrivateReaperCommand = "__cxx-grok-private-reaper"

var ErrPrivateDirectoryBusy = errors.New("Grok private directory still has an active holder")

// PrivateDirectory starts an independent cleaner before any credentials are
// written. The cleaner owns no secret and survives the launcher being killed.
type PrivateDirectory = privatehome.Directory

var privateHome = &privatehome.Spec{
	ReaperCommand: PrivateReaperCommand,
	Label:         "Grok",
	TempPrefixes:  []string{"cgx-runtime-", "cgx-login-"},
	EnvKeys:       []string{"GROK_HOME", "GROK_AUTH_PATH"},
	StateDir:      StateDir,
	Busy:          ErrPrivateDirectoryBusy,
}

func GuardPrivateDirectory(dir string, lifetimeLeases ...*ipc.Lock) (*PrivateDirectory, error) {
	return privateHome.Guard(dir, lifetimeLeases...)
}

// RunPrivateReaper accepts only the actual inherited descriptor for an owned
// 0700 directory. No untrusted pathname can substitute a different lock inode.
func RunPrivateReaper(args []string) int { return privateHome.RunReaper(args) }

// SweepPrivateDirectories recovers owned leftovers after a helper/host crash.
// It never uses age as proof: both the private lock and process fence must be idle.
func SweepPrivateDirectories() error { return privateHome.Sweep() }

// RemoveIdlePrivateDirectory removes only recognized runtime directories owned
// by this UID. Both maintenance and engine destruction use the same lifetime
// fence. A matching filename alone never authorizes deleting shared temp data.
// Unrecognized paths are left alone; an active owned path returns Busy.
func RemoveIdlePrivateDirectory(dir string) (bool, error) { return privateHome.RemoveIdle(dir) }
