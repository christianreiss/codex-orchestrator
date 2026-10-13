package residency

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"syscall"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/google/uuid"
)

type Journal struct {
	TransitionID string `json:"transition_id"`
	Source       string `json:"source_sha256"`
	Target       string `json:"target_sha256"`
	SourceOwner  string `json:"source_owner"`
	TargetOwner  string `json:"target_owner,omitempty"`
	Phase        Phase  `json:"phase"`
}

var digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func owned(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Getuid()
}

func (j Journal) Validate() error {
	if _, err := uuid.Parse(j.TransitionID); err != nil {
		return errors.New("invalid migration transition UUID")
	}
	if !digestPattern.MatchString(j.Source) || !digestPattern.MatchString(j.Target) || j.SourceOwner == "" {
		return errors.New("migration requires source identity and executable digests")
	}
	if _, err := uuid.Parse(j.SourceOwner); err != nil {
		return errors.New("invalid source owner UUID")
	}
	if j.TargetOwner != "" {
		if _, err := uuid.Parse(j.TargetOwner); err != nil {
			return errors.New("invalid target owner UUID")
		}
	}
	switch j.Phase {
	case Observed, Staged, Fenced, Draining, HandoffReady, Replaced, Verified, Reopened:
	default:
		return errors.New("invalid migration phase")
	}
	if (j.Phase == Replaced || j.Phase == Verified || j.Phase == Reopened) && j.TargetOwner == "" {
		return errors.New("migration target owner is missing")
	}
	return nil
}

// ReadJournal preserves the transition identity after a crash. Callers must
// inspect actual ownership before deciding whether to advance or roll back.
func ReadJournal(path string) (Journal, error) {
	var j Journal
	info, err := os.Lstat(path)
	if err != nil {
		return j, err
	}
	if !owned(info) || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		return j, errors.New("unsafe migration journal")
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return j, err
	}
	defer f.Close()
	decoder := json.NewDecoder(io.LimitReader(f, 64*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&j); err != nil {
		return j, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return j, errors.New("migration journal contains trailing data")
	}
	return j, j.Validate()
}

func CreateJournal(path string, initial Journal) error {
	if initial.Phase != Observed {
		return errors.New("migration must start at observed")
	}
	return saveJournal(path, initial, nil)
}

func AdvanceJournal(path string, expected, next Journal, evidence Evidence) error {
	if err := Next(expected.Phase, next.Phase, evidence); err != nil {
		return err
	}
	return saveJournal(path, next, &expected)
}

// saveJournal compares under the migration lock. An exact retry is harmless;
// another transition cannot replace it or change the executable identities.
func saveJournal(path string, next Journal, expected *Journal) error {
	if err := next.Validate(); err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil || !owned(info) || !info.IsDir() || info.Mode().Perm() != 0700 {
		return errors.New("unsafe migration directory")
	}
	lockFile, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	lockInfo, err := lockFile.Stat()
	lockFile.Close()
	if err != nil || !owned(lockInfo) || !lockInfo.Mode().IsRegular() || lockInfo.Mode().Perm() != 0600 {
		return errors.New("unsafe migration lock")
	}
	lock, err := ipc.TryAcquireExclusivePath(path + ".lock")
	if err != nil {
		return err
	}
	defer lock.Release()
	current, err := ReadJournal(path)
	if err == nil && current == next {
		return nil
	}
	if expected == nil {
		if !errors.Is(err, os.ErrNotExist) {
			return errors.New("migration journal already exists or is unreadable")
		}
	} else if err != nil || current != *expected || current.TransitionID != next.TransitionID ||
		current.Source != next.Source || current.Target != next.Target || current.SourceOwner != next.SourceOwner ||
		(current.TargetOwner != "" && current.TargetOwner != next.TargetOwner) {
		return errors.New("migration journal changed")
	}
	body, err := json.Marshal(next)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".migration-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err = f.Write(body); err == nil {
		err = f.Sync()
	}
	if err == nil {
		err = f.Close()
	}
	if err == nil {
		err = os.Rename(f.Name(), path)
	}
	if err != nil {
		return err
	}
	parent, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}

func DigestFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// StageBinary copies into a digest-named immutable artifact, leaving the
// executable used by the running systemd service untouched.
func StageBinary(source, directory, expectedDigest string) (string, error) {
	if !digestPattern.MatchString(expectedDigest) {
		return "", errors.New("invalid staged binary digest")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	info, err := os.Lstat(directory)
	if err != nil || !owned(info) || !info.IsDir() || info.Mode().Perm() != 0700 {
		return "", errors.New("unsafe staged binary directory")
	}
	target := filepath.Join(directory, "cxx-"+expectedDigest)
	if info, err := os.Lstat(target); err == nil {
		if !owned(info) || !info.Mode().IsRegular() || info.Mode().Perm() != 0555 {
			return "", errors.New("unsafe staged binary")
		}
		digest, err := DigestFile(target)
		if err != nil || digest != expectedDigest {
			return "", errors.New("staged binary digest mismatch")
		}
		return target, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	in, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer in.Close()
	out, err := os.CreateTemp(directory, ".binary-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(out.Name())
	defer out.Close()
	h := sha256.New()
	if _, err = io.Copy(io.MultiWriter(out, h), in); err != nil {
		return "", err
	}
	if hex.EncodeToString(h.Sum(nil)) != expectedDigest {
		return "", errors.New("source binary changed while staging")
	}
	if err := out.Chmod(0555); err != nil {
		return "", err
	}
	if err := out.Sync(); err != nil {
		return "", err
	}
	if err := out.Close(); err != nil {
		return "", err
	}
	// Link is exclusive: parallel staging never overwrites a digest-named file.
	if err := os.Link(out.Name(), target); err != nil {
		if errors.Is(err, os.ErrExist) {
			return StageBinary(source, directory, expectedDigest)
		}
		return "", fmt.Errorf("publish staged binary: %w", err)
	}
	parent, err := os.Open(directory)
	if err != nil {
		return "", err
	}
	defer parent.Close()
	return target, parent.Sync()
}
