package codex

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// HasProfile reports whether the Codex home defines the profile <name>: either
// as `<name>.config.toml` (the layout codex-cli >= 0.156.1 requires) or, for an
// older Codex, as a [profiles.<name>] section of config.toml. Lets the cdx
// command dispatcher recognise the `cdx <profile-name>` shorthand without taking
// a TOML parser dependency.
//
// The legacy scan matches both bare (`[profiles.name]`) and double-bracketed
// (`[[profiles.name]]`) headers, ignores leading/trailing whitespace, and
// honours `#` comments at the start of a line.
func HasProfile(name string) bool {
	if name == "" {
		return false
	}
	if !validProfileName(name) {
		return false
	}
	if home, err := CodexHome(); err == nil {
		if info, err := os.Stat(filepath.Join(home, name+".config.toml")); err == nil && info.Mode().IsRegular() {
			return true
		}
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

// validProfileName keeps the shorthand from probing outside the Codex home: the
// name becomes a file name.
func validProfileName(name string) bool {
	if name == "" || len(name) > 64 {
		return false
	}
	for i, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case (r == '_' || r == '-') && i > 0:
		default:
			return false
		}
	}
	return true
}

// ProfileManifestFile lists, inside the Codex home, the `<name>.config.toml`
// profile files the fleet itself wrote. It is the only authority for deleting
// one: anything not named here belongs to the user.
const ProfileManifestFile = ".cxx-managed-profiles.json"

// ManagedProfileNames returns the fleet-written profile names recorded in home.
func ManagedProfileNames(home string) map[string]bool {
	owned := map[string]bool{}
	raw, err := os.ReadFile(filepath.Join(home, ProfileManifestFile))
	if err != nil {
		return owned
	}
	var m struct {
		Names []string `json:"names"`
	}
	if json.Unmarshal(raw, &m) != nil {
		return owned
	}
	for _, name := range m.Names {
		if validProfileName(name) {
			owned[name] = true
		}
	}
	return owned
}
