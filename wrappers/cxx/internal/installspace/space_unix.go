//go:build !windows

package installspace

import (
	"os"
	"path/filepath"
	"syscall"
)

// Inspect follows symlinks and resolves missing directories without creating them.
func Inspect(path string) (Capacity, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return Capacity{}, err
	}
	for {
		info, err := os.Stat(path)
		if err == nil {
			if !info.IsDir() {
				path = filepath.Dir(path)
			}
			break
		}
		if !os.IsNotExist(err) {
			return Capacity{}, err
		}
		parent := filepath.Dir(path)
		if parent == path {
			return Capacity{}, err
		}
		path = parent
	}
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		return Capacity{}, err
	}
	var st syscall.Stat_t
	if err := syscall.Stat(path, &st); err != nil {
		return Capacity{}, err
	}
	// BSD can report a negative available block count when the filesystem
	// is using its reserved blocks. Treat that as no installable space.
	var available uint64
	if fs.Bavail > 0 && fs.Bsize > 0 {
		available = uint64(fs.Bavail) * uint64(fs.Bsize)
	}
	return Capacity{Device: uint64(st.Dev), Bytes: available, Inodes: uint64(fs.Ffree), InodesKnown: fs.Files > 0}, nil
}
