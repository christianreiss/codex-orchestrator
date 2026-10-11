package lifecycle

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

type skillDirectoryID struct {
	Device uint64 `json:"device"`
	Inode  uint64 `json:"inode"`
}
type pendingSkillBundle struct {
	Slug     string            `json:"slug"`
	Stage    string            `json:"stage"`
	Identity skillDirectoryID  `json:"identity"`
	Previous *skillDirectoryID `json:"previous,omitempty"`
	Entry    manifestEntry     `json:"entry"`
}

func identifySkillDirectory(path string) (skillDirectoryID, error) {
	st, err := os.Lstat(path)
	if err != nil {
		return skillDirectoryID{}, err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return skillDirectoryID{}, fmt.Errorf("not a real skill directory: %s", path)
	}
	return skillDirectoryID{Device: uint64(sys.Dev), Inode: uint64(sys.Ino)}, nil
}
func prepareSkillPublication(root, manPath, slug, stage string, rec manifestEntry) error {
	id, err := identifySkillDirectory(stage)
	if err != nil {
		return err
	}
	p := pendingSkillBundle{Slug: slug, Stage: filepath.Base(stage), Identity: id, Entry: rec}
	old, err := identifySkillDirectory(filepath.Join(root, slug))
	if err == nil {
		p.Previous = &old
	} else if !os.IsNotExist(err) {
		return err
	}
	if err = atomicdir.SyncTree(stage); err != nil {
		return err
	}
	return writeSkillState(manPath+".pending", p)
}

func saveSkillManifest(path string, man collectionManifest) error {
	man.Version = 1
	if man.Items == nil {
		man.Items = map[string]manifestEntry{}
	}
	return writeSkillState(path, man)
}

// Ownership must be durable before the publication intent can be cleared.
// Keep the existing manifest schema while syncing both the file and its name.
func writeSkillState(path string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".skills-state-*")
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
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	return atomicdir.SyncDir(filepath.Dir(path))
}

func clearSkillPublication(manPath string) error {
	if err := os.Remove(manPath + ".pending"); err != nil && !os.IsNotExist(err) {
		return err
	}
	return atomicdir.SyncDir(filepath.Dir(manPath))
}
func recoverSkillPublication(root, manPath string) error {
	raw, err := os.ReadFile(manPath + ".pending")
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var p pendingSkillBundle
	if err = json.Unmarshal(raw, &p); err != nil {
		return err
	}
	if _, ok := canonicalSkillOwnership(p.Slug, p.Entry); !ok || p.Stage != filepath.Base(p.Stage) || !strings.HasPrefix(p.Stage, "."+p.Slug+".new-") || p.Identity.Inode == 0 {
		return errors.New("invalid pending skill publication")
	}
	target := filepath.Join(root, p.Slug)
	stage := filepath.Join(root, p.Stage)
	targetID, targetErr := identifySkillDirectory(target)
	stageID, stageErr := identifySkillDirectory(stage)
	if targetErr == nil && targetID == p.Identity {
		// Only the staged inode grants ownership. Changed owned bytes withhold
		// their digest through skillBundlePresent and are healed by the next sync.
		man := loadManifest(manPath)
		man.Items[p.Slug] = p.Entry
		if err = saveSkillManifest(manPath, man); err != nil {
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
		if err = atomicdir.SyncDir(root); err != nil {
			return err
		}
	} else if stageErr != nil && !os.IsNotExist(stageErr) {
		return stageErr
	}
	return clearSkillPublication(manPath)
}
