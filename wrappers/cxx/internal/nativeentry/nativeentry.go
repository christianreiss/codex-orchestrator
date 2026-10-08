// Package nativeentry installs native CLI names without modifying vendor binaries.
package nativeentry

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
)

const marker = "# cxx:managed-native-entry:v1"
const blockStart = "# cxx:managed-native-path:start"
const blockEnd = "# cxx:managed-native-path:end"

type Options struct {
	Home        string
	WrapperPath string
	Engines     []string
}

func BinDir(home string) string { return filepath.Join(home, ".cxx", "native-bin") }
func quote(s string) string     { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
func validEngine(e string) bool { return e == "codex" || e == "claude" || e == "grok" }

// AssignedEngines requires an explicit signed assignment; absent lists never
// create a Codex fallback. Suspension keeps the shim and is enforced at launch.
func AssignedEngines(cfg *config.Config) []string {
	if cfg == nil {
		return nil
	}
	candidates := cfg.Host.EnginesList
	if len(candidates) == 0 {
		candidates = strings.FieldsFunc(cfg.Host.Engines, func(r rune) bool { return r == ',' || r == ' ' || r == ';' })
	}
	seen := map[string]bool{}
	var out []string
	for _, e := range candidates {
		if validEngine(e) && !seen[e] {
			seen[e] = true
			out = append(out, e)
		}
	}
	return out
}

func IsManagedShim(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	prefix := "#!/bin/sh\n" + marker + "\n"
	buf := make([]byte, len(prefix))
	_, err = io.ReadFull(f, buf)
	return err == nil && string(buf) == prefix
}

func atomicWrite(path string, body []byte, mode os.FileMode) error {
	temp, err := os.CreateTemp(filepath.Dir(path), ".native-entry-*")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	if err = temp.Chmod(mode); err == nil {
		_, err = temp.Write(body)
	}
	closeErr := temp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, path)
}

func Install(opts Options) error { return install(opts, false) }

// Sync reconciles the complete signed assignment and removes obsolete managed entries.
func Sync(home, wrapper string, assigned []string) error {
	return install(Options{Home: home, WrapperPath: wrapper, Engines: assigned}, true)
}

func install(opts Options, authoritative bool) error {
	if !filepath.IsAbs(opts.Home) || !filepath.IsAbs(opts.WrapperPath) || strings.ContainsAny(opts.WrapperPath+opts.Home, "\r\n") {
		return errors.New("native entry requires absolute home and wrapper paths")
	}
	wanted := map[string]bool{}
	for _, e := range opts.Engines {
		if !validEngine(e) {
			return fmt.Errorf("unknown engine %q", e)
		}
		wanted[e] = true
	}
	lock, err := acquireEntryLock(opts.Home)
	if err != nil {
		return err
	}
	defer lock.Release()
	dir := BinDir(opts.Home)
	if err := validateShells(opts.Home); err != nil {
		return err
	}
	if info, err := os.Lstat(dir); err == nil && (info.Mode()&os.ModeSymlink != 0 || !info.IsDir()) {
		return fmt.Errorf("native entry directory is not a real directory: %s", dir)
	}
	for _, e := range []string{"codex", "claude", "grok"} {
		path := filepath.Join(dir, e)
		if info, err := os.Lstat(path); err == nil {
			if info.Mode()&os.ModeSymlink != 0 || !IsManagedShim(path) {
				return fmt.Errorf("refusing to overwrite unmanaged native entry %s", path)
			}
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	if len(wanted) > 0 {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
	}
	for _, e := range []string{"codex", "claude", "grok"} {
		path := filepath.Join(dir, e)
		if info, err := os.Lstat(path); err == nil && (info.Mode()&os.ModeSymlink != 0 || !IsManagedShim(path)) {
			return fmt.Errorf("refusing to overwrite unmanaged native entry %s", path)
		} else if err != nil && !os.IsNotExist(err) {
			return err
		}
		if wanted[e] {
			body := "#!/bin/sh\n" + marker + "\nexec " + quote(opts.WrapperPath) + " native " + e + " -- \"$@\"\n"
			if err := atomicWrite(path, []byte(body), 0700); err != nil {
				return err
			}
		} else if authoritative && IsManagedShim(path) {
			if err := os.Remove(path); err != nil {
				return err
			}
		}
	}
	return updateShells(opts.Home, hasInstalled(opts.Home))
}

// Remove touches only files carrying our marker and our managed shell block.
func Remove(opts Options) error {
	if !filepath.IsAbs(opts.Home) {
		return errors.New("native entry requires absolute home path")
	}
	lock, err := acquireEntryLock(opts.Home)
	if err != nil {
		return err
	}
	defer lock.Release()
	if err := validateShells(opts.Home); err != nil {
		return err
	}
	engines := opts.Engines
	if len(engines) == 0 {
		engines = []string{"codex", "claude", "grok"}
	}
	for _, e := range engines {
		if !validEngine(e) {
			return fmt.Errorf("unknown engine %q", e)
		}
	}
	for _, e := range engines {
		path := filepath.Join(BinDir(opts.Home), e)
		if IsManagedShim(path) {
			if err := os.Remove(path); err != nil {
				return err
			}
		}
	}
	return updateShells(opts.Home, hasInstalled(opts.Home))
}

func hasInstalled(home string) bool {
	for _, e := range []string{"codex", "claude", "grok"} {
		if IsManagedShim(filepath.Join(BinDir(home), e)) {
			return true
		}
	}
	return false
}

// IsWrapperOrShim guards cached and explicitly configured native binaries.
func IsWrapperOrShim(path, currentExe string) bool {
	if IsManagedShim(path) {
		return true
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return false
	}
	self, _ := filepath.EvalSymlinks(currentExe)
	candidateInfo, candidateErr := os.Stat(path)
	selfInfo, selfErr := os.Stat(currentExe)
	sameFile := candidateErr == nil && selfErr == nil && os.SameFile(candidateInfo, selfInfo)
	return sameFile || (self != "" && resolved == self) || filepath.Base(resolved) == "cxx"
}

type Status struct {
	Installed            []string `json:"installed"`
	PathActive           bool     `json:"path_active"`
	ShellRestartRequired bool     `json:"shell_restart_required"`
}

// Diagnose reports executable PATH resolution; shell aliases/functions must be
// refreshed separately by the owning shell and are not visible to this process.
func Diagnose(home string) Status {
	status := Status{}
	for _, e := range []string{"codex", "claude", "grok"} {
		if IsManagedShim(filepath.Join(BinDir(home), e)) {
			status.Installed = append(status.Installed, e)
		}
	}
	status.PathActive = len(status.Installed) > 0
	for _, e := range status.Installed {
		resolved, err := exec.LookPath(e)
		if err != nil || !IsManagedShim(resolved) {
			status.PathActive = false
			break
		}
		expected, err := os.Stat(filepath.Join(BinDir(home), e))
		actual, otherErr := os.Stat(resolved)
		if err != nil || otherErr != nil || !os.SameFile(expected, actual) {
			status.PathActive = false
			break
		}
	}
	status.ShellRestartRequired = len(status.Installed) > 0 && !status.PathActive
	return status
}

// ResolveVendor excludes managed entry scripts and the wrapper itself, even
// through symlinks. It never mutates PATH or invokes a candidate to inspect it.
func ResolveVendor(name, currentExe string) (string, error) {
	if !validEngine(name) && name != "claude-code" {
		return "", fmt.Errorf("unknown native executable %q", name)
	}
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if dir == "" {
			continue
		}
		path := filepath.Join(dir, name)
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 || IsManagedShim(path) {
			continue
		}
		if IsWrapperOrShim(path, currentExe) {
			continue
		}
		return path, nil
	}
	return "", fmt.Errorf("native %s executable not found outside managed entrypoints", name)
}

// One lock covers shims and all shell blocks, including the last-entry decision.
// The per-user absolute native-bin target keeps independent users independent.
func acquireEntryLock(home string) (*layout.Lock, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	lock, err := layout.AcquireForTarget(ctx, BinDir(home))
	if err != nil {
		return nil, fmt.Errorf("native entry update could not acquire lock; retry: %w", err)
	}
	return lock, nil
}
