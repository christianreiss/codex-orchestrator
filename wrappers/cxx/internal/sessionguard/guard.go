// Package sessionguard fences native launch/resume against journaled session removal.
package sessionguard

import (
	"errors"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"os"
	"path/filepath"
)

func Root(engine string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	env := map[string]string{"codex": "CODEX_HOME", "claude": "CLAUDE_CONFIG_DIR", "grok": "GROK_HOME"}[engine]
	if env == "" {
		return "", errors.New("unknown housekeeping engine")
	}
	root := os.Getenv(env)
	// Managed Claude deliberately strips CLAUDE_CONFIG_DIR before launch:
	// credentials and native session storage stay in the default ~/.claude.
	if engine == "claude" {
		root = ""
	}
	if root == "" {
		root = filepath.Join(home, "."+engine)
	}
	return filepath.Abs(root)
}
func Launch(engine string) (*ipc.Lock, error) {
	root, err := Root(engine)
	if err != nil {
		return nil, err
	}
	return LaunchAt(root)
}
func LaunchAt(root string) (*ipc.Lock, error) {
	lock, err := ipc.TryAcquireSharedPath(filepath.Join(root, ".cxx-housekeeping.lock"))
	if err != nil {
		return nil, err
	}
	if _, err = os.Lstat(filepath.Join(root, ".cxx-housekeeping", "journal.json")); !os.IsNotExist(err) {
		_ = lock.Release()
		return nil, errors.New("session housekeeping journal requires recovery; run cxx housekeeping run")
	}
	return lock, nil
}
func Maintenance(root string) (*ipc.Lock, error) {
	return ipc.TryAcquireExclusivePath(filepath.Join(root, ".cxx-housekeeping.lock"))
}

// GrokSessionsLockName is the lifetime lease of a managed Grok session in the
// native home. grok.NewRuntime holds the launch guard (LaunchAt) only while it
// builds the private runtime and then releases it; this lease, held shared and
// duplicated into the native child by AttachChild, is what lasts for the
// session.
const GrokSessionsLockName = ".cgx-sessions.lock"

// GrokSessionActive reports whether any managed Grok session (or `cgx login`)
// still holds the lifetime lease under root. Only a held flock counts: the
// lock file's presence or age proves nothing, and a missing file means no
// session has ever run there, so the probe never creates it. An error is an
// unproven answer and must be treated as busy.
func GrokSessionActive(root string) (bool, error) {
	path := filepath.Join(root, GrokSessionsLockName)
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	lock, err := ipc.TryAcquireExclusivePath(path)
	if errors.Is(err, ipc.ErrHeld) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	_ = lock.Release()
	return false, nil
}
