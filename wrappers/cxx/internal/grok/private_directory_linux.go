package grok

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func privateDirectoryInUse(dir string) bool {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return true
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "environ"))
		if err != nil {
			continue
		}
		for _, item := range strings.Split(string(raw), "\x00") {
			key, value, _ := strings.Cut(item, "=")
			if (key == "GROK_HOME" || key == "GROK_AUTH_PATH") && (value == dir || strings.HasPrefix(value, dir+string(os.PathSeparator))) {
				return true
			}
		}
	}
	return false
}
