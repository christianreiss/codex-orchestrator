// Package atomicdir publishes complete directories without a missing-target
// window. Replacement requires the platform's atomic exchange primitive.
package atomicdir

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

func SyncDir(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func SyncTree(root string) error {
	var dirs []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			dirs = append(dirs, path)
			return nil
		}
		if !d.Type().IsRegular() {
			return errors.New("staged directory contains a non-regular file")
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		return errors.Join(f.Sync(), f.Close())
	})
	if err != nil {
		return err
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		if err = SyncDir(dirs[i]); err != nil {
			return err
		}
	}
	return nil
}

// Publish leaves the previous directory at stage after a successful exchange;
// callers own cleanup. Unsupported exchanges leave the target unchanged.
func Publish(stage, target string, replace bool) error {
	if filepath.Dir(stage) != filepath.Dir(target) {
		return errors.New("directory publication requires sibling paths")
	}
	if err := SyncTree(stage); err != nil {
		return err
	}
	var err error
	if replace {
		err = exchange(stage, target)
	} else {
		err = renameNew(stage, target)
	}
	if err != nil {
		return err
	}
	return SyncDir(filepath.Dir(target))
}
