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
