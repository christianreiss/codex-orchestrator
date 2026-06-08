package claude

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const shellAliasLine = "alias claude='clx'"

// EnsureShellAliases appends `alias claude='clx'` to ~/.bashrc and ~/.zshrc
// when the alias is not already present. Missing files are silently skipped;
// errors from existing files are collected and returned.
func EnsureShellAliases() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	var errs []string
	for _, rc := range []string{".bashrc", ".zshrc"} {
		if err := ensureAliasInFile(filepath.Join(home, rc)); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", rc, err))
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

func ensureAliasInFile(path string) error {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if strings.Contains(string(b), shellAliasLine) {
		return nil
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, werr := fmt.Fprintf(f, "\n# Added by clx\n%s\n", shellAliasLine)
	f.Close()
	return werr
}
