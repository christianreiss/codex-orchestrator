package skillstore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/atomicdir"
)

type directoryID struct {
	Device uint64 `json:"device"`
	Inode  uint64 `json:"inode"`
}
type pendingBundle struct {
	Slug     string       `json:"slug"`
	Stage    string       `json:"stage"`
	Identity directoryID  `json:"identity"`
	Previous *directoryID `json:"previous,omitempty"`
	Entry    entry        `json:"entry"`
}

func identifyDirectory(path string) (directoryID, error) {
	st, err := os.Lstat(path)
	if err != nil {
		return directoryID{}, err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return directoryID{}, fmt.Errorf("not a real skill directory: %s", path)
	}
	return directoryID{Device: uint64(sys.Dev), Inode: uint64(sys.Ino)}, nil
}
func (s Store) preparePending(slug, stage string, rec entry) error {
	id, err := identifyDirectory(stage)
	if err != nil {
		return err
	}
	p := pendingBundle{Slug: slug, Stage: filepath.Base(stage), Identity: id, Entry: rec}
	old, err := identifyDirectory(filepath.Join(s.Root, slug))
	if err == nil {
		p.Previous = &old
	} else if !os.IsNotExist(err) {
		return err
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if err = atomicdir.SyncTree(stage); err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(s.ManifestPath), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(s.ManifestPath), ".skills-pending-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err = f.Write(raw); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), s.ManifestPath+".pending"); err != nil {
		return err
	}
	return atomicdir.SyncDir(filepath.Dir(s.ManifestPath))
}
func (s Store) clearPending() error {
	if err := os.Remove(s.ManifestPath + ".pending"); err != nil && !os.IsNotExist(err) {
		return err
	}
	return atomicdir.SyncDir(filepath.Dir(s.ManifestPath))
}
func (s Store) recoverPending() error {
	raw, err := os.ReadFile(s.ManifestPath + ".pending")
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var p pendingBundle
	if err = json.Unmarshal(raw, &p); err != nil {
		return err
	}
	if _, ok := ownership(p.Slug, p.Entry); !ok || p.Stage != filepath.Base(p.Stage) || !strings.HasPrefix(p.Stage, "."+p.Slug+".new-") || p.Identity.Inode == 0 {
		return errors.New("invalid pending skill publication")
	}
	target := filepath.Join(s.Root, p.Slug)
	stage := filepath.Join(s.Root, p.Stage)
	targetID, targetErr := identifyDirectory(target)
	stageID, stageErr := identifyDirectory(stage)
	if targetErr == nil && targetID == p.Identity {
		// Only the staged inode grants ownership. Changed owned bytes withhold
		// their digest through bundlePresent and are healed by the next sync.
		man := s.load()
		man.Items[p.Slug] = p.Entry
		if err = s.save(man); err != nil {
			return err
		}
	} else if stageErr == nil && stageID == p.Identity {
		// Publication never happened. Keep the old/user target untouched.
	} else if os.IsNotExist(stageErr) && (os.IsNotExist(targetErr) || (p.Previous != nil && targetErr == nil && targetID == *p.Previous)) {
		// A returned publication error cleaned staging before manifest commit.
	} else {
		return errors.New("pending skill publication conflicts with changed directory identities; preserving both paths")
	}
	if stageErr == nil && (stageID == p.Identity || (p.Previous != nil && stageID == *p.Previous)) {
		if err = os.RemoveAll(stage); err != nil {
			return err
		}
		if err = atomicdir.SyncDir(s.Root); err != nil {
			return err
		}
	} else if stageErr != nil && !os.IsNotExist(stageErr) {
		return stageErr
	}
	return s.clearPending()
}
