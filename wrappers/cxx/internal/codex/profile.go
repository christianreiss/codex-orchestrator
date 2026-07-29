package codex

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// HasProfile reports whether ~/.codex/config.toml declares a [profiles.<name>]
// section. Lets the cdx command dispatcher recognise the legacy
// `cdx <profile-name>` shorthand without taking a TOML parser dependency.
//
// Matches both bare (`[profiles.name]`) and double-bracketed
// (`[[profiles.name]]`) headers, ignores leading/trailing whitespace, and
// honours `#` comments at the start of a line.
func HasProfile(name string) bool {
	if name == "" {
		return false
	}
	path := configTomlPath()
	if path == "" {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()

	needles := []string{
		"[profiles." + name + "]",
		"[[profiles." + name + "]]",
	}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		for _, n := range needles {
			if line == n {
				return true
			}
		}
	}
	return false
}

func configTomlPath() string {
	home, err := CodexHome()
	if err != nil {
		return ""
	}
	return filepath.Join(home, "config.toml")
}
