package nativeentry

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var shellFiles = []string{".bashrc", ".zshrc", ".config/fish/config.fish"}

// bashLoginFiles are the startup files of a bash login shell (`su -l`, ssh),
// which reads only the first one that exists and never ~/.bashrc unless that
// file sources it.
var bashLoginFiles = []string{".bash_profile", ".bash_login", ".profile"}

// LoginProfile names the file a bash login shell reads for home: the first
// existing entry of bashLoginFiles, or ~/.profile when none exists. ~/.profile
// is never shadowed by creating a .bash_profile.
func LoginProfile(home string) string {
	for _, relative := range bashLoginFiles {
		if _, err := os.Stat(filepath.Join(home, relative)); err == nil {
			return filepath.Join(home, relative)
		}
	}
	return filepath.Join(home, ".profile")
}

// loginTargets selects which login files carry the managed block: the one
// bash reads, plus an existing ~/.profile for POSIX sh login shells. The block
// is guarded by a PATH membership test, so a profile that also sources
// ~/.bashrc does not duplicate the PATH entry.
func loginTargets(home string) map[string]bool {
	targets := map[string]bool{}
	if relative, err := filepath.Rel(home, LoginProfile(home)); err == nil {
		targets[relative] = true
	}
	if _, err := os.Stat(filepath.Join(home, ".profile")); err == nil {
		targets[".profile"] = true
	}
	return targets
}

func validateShells(home string) error {
	for _, relative := range append(append([]string{}, shellFiles...), bashLoginFiles...) {
		path := filepath.Join(home, relative)
		body, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		text := string(body)
		a, b := strings.Count(text, blockStart), strings.Count(text, blockEnd)
		if a != b || a > 1 || (a == 1 && strings.Index(text, blockStart) > strings.Index(text, blockEnd)) {
			return fmt.Errorf("invalid managed native PATH block in %s", path)
		}
	}
	return nil
}

func updateShells(home string, enabled bool) error {
	// Decide login targets before any write can create ~/.profile.
	targets := loginTargets(home)
	for _, relative := range shellFiles {
		if err := updateShellFile(home, relative, enabled); err != nil {
			return err
		}
	}
	for _, relative := range bashLoginFiles {
		if err := updateShellFile(home, relative, enabled && targets[relative]); err != nil {
			return err
		}
	}
	return nil
}

func updateShellFile(home, relative string, enabled bool) error {
	path := filepath.Join(home, relative)
	body, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		if !enabled {
			return nil
		}
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		body = nil
		err = nil
	}
	if err != nil {
		return err
	}
	text := string(body)
	if start := strings.Index(text, blockStart); start >= 0 {
		end := strings.Index(text[start:], blockEnd)
		if end < 0 {
			return fmt.Errorf("incomplete managed native PATH block in %s", path)
		}
		end += start + len(blockEnd)
		if end < len(text) && text[end] == '\n' {
			end++
		}
		text = text[:start] + text[end:]
	}
	if enabled {
		line := "case \":$PATH:\" in\n  *:" + quote(BinDir(home)) + ":*) ;;\n  *) export PATH=" + quote(BinDir(home)) + ":\"$PATH\" ;;\nesac"
		if strings.HasSuffix(relative, "config.fish") {
			line = "fish_add_path --path --prepend --move " + fishQuote(BinDir(home))
		}
		if text != "" && !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		text += blockStart + "\n" + line + "\n" + blockEnd + "\n"
	}
	if text != string(body) {
		mode := os.FileMode(0600)
		if info, err := os.Stat(path); err == nil {
			mode = info.Mode().Perm()
		}
		target := path
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			target = resolved
		}
		if err := atomicWrite(target, []byte(text), mode); err != nil {
			return err
		}
	}
	return nil
}

// Fish recognizes escapes inside single quotes, unlike POSIX shells.
func fishQuote(value string) string {
	return "'" + strings.NewReplacer("\\", "\\\\", "'", "\\'").Replace(value) + "'"
}
