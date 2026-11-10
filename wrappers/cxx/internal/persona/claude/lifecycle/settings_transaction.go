package lifecycle

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

var (
	ErrManagedSettingsLocked = errors.New("another wrapper is updating Claude settings; retry sync")
	ErrUserSettingsChanged   = errors.New("Claude settings changed during merge; retry sync")
)

// Only cooperating wrappers take this lock. Claude Code 2.1.322 serializes its
// settings saves in-process, not with a cross-process settings-file lock.
func acquireSettingsMutationLock() (*ipc.Lock, error) {
	lock, err := ipc.TryAcquireExclusivePath(managedStatePath() + ".lock")
	if errors.Is(err, ipc.ErrHeld) {
		return nil, ErrManagedSettingsLocked
	}
	return lock, err
}

type settingsSnapshot struct {
	raw  []byte
	info os.FileInfo // nil distinguishes an absent file from an existing empty one
}

func sameSettingsFile(a, b os.FileInfo) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return os.SameFile(a, b) && a.Mode() == b.Mode() && a.Size() == b.Size() && a.ModTime().Equal(b.ModTime())
}

func readSettingsSnapshot(path string) (settingsSnapshot, error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return settingsSnapshot{}, nil
	}
	if err != nil {
		return settingsSnapshot{}, err
	}
	defer f.Close()
	before, err := f.Stat()
	if err != nil {
		return settingsSnapshot{}, err
	}
	if !before.Mode().IsRegular() {
		return settingsSnapshot{}, fmt.Errorf("settings %s must be a regular file", path)
	}
	raw, err := io.ReadAll(f)
	if err != nil {
		return settingsSnapshot{}, err
	}
	after, err := f.Stat()
	if err != nil {
		return settingsSnapshot{}, err
	}
	if !sameSettingsFile(before, after) {
		return settingsSnapshot{}, ErrUserSettingsChanged
	}
	return settingsSnapshot{raw: raw, info: after}, nil
}

func (s settingsSnapshot) current(path string) error {
	current, err := readSettingsSnapshot(path)
	if err != nil {
		return err
	}
	if !sameSettingsFile(s.info, current.info) || !bytesEqual(s.raw, current.raw) {
		return ErrUserSettingsChanged
	}
	return nil
}

func (s settingsSnapshot) mode() os.FileMode {
	if s.info == nil {
		return 0o600
	}
	return s.info.Mode().Perm()
}

type settingsPublisher func(string, []byte, settingsSnapshot) error

// Stage before the final check, avoiding unrelated I/O between the check and
// rename. This is optimistic conflict detection, NOT atomic CAS: native can
// publish in that last gap, or later publish a transform it read before ours.
func publishSettingsSnapshot(path string, body []byte, expected settingsSnapshot) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".settings-merge-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if err := tmp.Chmod(expected.mode()); err != nil {
		return err
	}
	if _, err := tmp.Write(body); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := expected.current(path); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// The caller holds the wrapper settings lock across this merge, the mirror and
// the ownership sidecar. Detected native/local changes rebase from fresh bytes;
// malformed or continuously changing input leaves ownership pending for retry.
func mergeSettingsFile(path string, partial map[string]any, owned []string, prev managedState, skipAbsent bool, publish settingsPublisher) ([]byte, managedState, bool, error) {
	if publish == nil {
		publish = publishSettingsSnapshot
	}
	for attempt := 0; attempt < 3; attempt++ {
		snapshot, err := readSettingsSnapshot(path)
		if errors.Is(err, ErrUserSettingsChanged) {
			continue
		}
		if err != nil {
			return nil, prev, false, err
		}
		if snapshot.info == nil && skipAbsent {
			return nil, prev, false, nil
		}
		merged, next, err := MergeSettings(snapshot.raw, partial, owned, prev)
		if err != nil {
			return nil, prev, false, err
		}
		changed := !bytesEqual(snapshot.raw, merged)
		if changed {
			err = publish(path, merged, snapshot)
		} else {
			err = snapshot.current(path)
		}
		if errors.Is(err, ErrUserSettingsChanged) {
			continue
		}
		if err != nil {
			return nil, prev, false, err
		}
		return merged, next, changed, nil
	}
	return nil, prev, false, ErrUserSettingsChanged
}

func writeSettingsMirror(path string, body []byte) (bool, error) {
	for attempt := 0; attempt < 3; attempt++ {
		snapshot, err := readSettingsSnapshot(path)
		if errors.Is(err, ErrUserSettingsChanged) {
			continue
		}
		if err != nil {
			return false, err
		}
		if bytesEqual(snapshot.raw, body) {
			return false, nil
		}
		err = publishSettingsSnapshot(path, body, snapshot)
		if errors.Is(err, ErrUserSettingsChanged) {
			continue
		}
		return err == nil, err
	}
	return false, ErrUserSettingsChanged
}
