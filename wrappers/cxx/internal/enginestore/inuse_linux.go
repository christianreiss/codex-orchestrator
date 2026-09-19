package enginestore

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// inUse reports whether any visible process is executing from dir. /proc is
// authoritative here: /proc/<pid>/exe is the kernel's own record of the
// executable, so it survives argv rewriting and relative paths.
//
// Processes owned by other users are unreadable and simply do not match. That
// is acceptable: the engine store is per-user (~/.cxx), so a prefix in use by
// another account is not in this root.
func inUse(dir string) bool {
	prefix := strings.TrimSuffix(dir, string(os.PathSeparator)) + string(os.PathSeparator)
	entries, err := os.ReadDir("/proc")
	if err != nil {
		// Without /proc we cannot prove the prefix is idle, so treat it as
		// busy rather than delete it out from under a running engine.
		return true
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, err := strconv.Atoi(entry.Name()); err != nil {
			continue
		}
		exe, err := os.Readlink(filepath.Join("/proc", entry.Name(), "exe"))
		if err != nil {
			continue
		}
		if strings.HasPrefix(exe, prefix) {
			return true
		}
	}
	return false
}
