// Package claude includes installer.go which installs or updates the
// `@anthropic-ai/claude-code` npm package. Unlike cdx, there is no GitHub
// release pipeline for the Claude CLI — npm-global is the only path.
package claude

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// EnsureClaude makes sure the locally-installed Claude CLI is at the target
// version (or just installed at all). enforceExact=true always reinstalls
// the pinned version; enforceExact=false short-circuits when the local
// version already matches.
func EnsureClaude(ctx context.Context, target string, enforceExact bool, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}

	if _, err := exec.LookPath("npm"); err != nil {
		return errors.New("EnsureClaude: npm not available on PATH")
	}

	current := strings.TrimSpace(Version(ctx))
	if !enforceExact && current != "" && current != "unknown" && target != "" {
		if current == target {
			logger.Debug("EnsureClaude: already at target", "version", current)
			return nil
		}
		if !semverGT(target, current) {
			logger.Debug("EnsureClaude: skipping downgrade", "current", current, "target", target)
			return nil
		}
	}
	if !enforceExact && IsDowngrade(current, target) {
		logger.Debug("EnsureClaude: skipping downgrade", "current", current, "target", target)
		return nil
	}

	spec := "@anthropic-ai/claude-code"
	if target != "" && target != "latest" {
		spec = "@anthropic-ai/claude-code@" + target
	}
	logger.Debug("EnsureClaude: npm install", "spec", spec, "enforce_exact", enforceExact)

	args := []string{"install", "-g", spec}
	cmd := exec.CommandContext(ctx, "npm", args...)
	out, err := cmd.CombinedOutput()
	if err == nil {
		cacheInstalledClaude(ctx)
		return nil
	}
	if isPermErr(out, err) {
		if _, lerr := exec.LookPath("sudo"); lerr == nil {
			logger.Debug("EnsureClaude: retrying npm install under sudo -n")
			sudoArgs := append([]string{"-n", "npm"}, args...)
			cmd = exec.CommandContext(ctx, "sudo", sudoArgs...)
			out2, serr := cmd.CombinedOutput()
			if serr == nil {
				cacheInstalledClaude(ctx)
				return nil
			}
			return fmt.Errorf("npm install %s failed under sudo: %w: %s", spec, serr, strings.TrimSpace(string(out2)))
		}
	}
	return fmt.Errorf("npm install %s failed: %w: %s", spec, err, strings.TrimSpace(string(out)))
}

// cacheInstalledClaude resolves the claude binary location via npm's global
// bin dir and writes it to the cache so future runs (including cron) can find
// it without a full PATH lookup.
func cacheInstalledClaude(ctx context.Context) {
	out, err := exec.CommandContext(ctx, "npm", "bin", "-g").Output()
	if err == nil {
		dir := strings.TrimSpace(string(out))
		for _, name := range []string{"claude", "claude-code"} {
			p := filepath.Join(dir, name)
			if _, serr := os.Stat(p); serr == nil {
				_ = cacheClaude(p)
				return
			}
		}
	}
	// Fallback: standard PATH lookup.
	for _, name := range []string{"claude", "claude-code"} {
		if p, lerr := exec.LookPath(name); lerr == nil {
			_ = cacheClaude(p)
			return
		}
	}
}

func isPermErr(out []byte, err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(string(out))
	return strings.Contains(s, "eacces") ||
		strings.Contains(s, "permission denied") ||
		strings.Contains(s, "operation not permitted")
}

// IsDowngrade reports whether installing target would be a downgrade from current.
// Returns false when either version is unparseable.
func IsDowngrade(current, target string) bool {
	if current == "" || current == "unknown" || target == "" || target == "latest" {
		return false
	}
	cv, okC := parseSemverTriple(current)
	tv, okT := parseSemverTriple(target)
	if !okC || !okT {
		return false
	}
	for i := 0; i < 3; i++ {
		if cv[i] > tv[i] {
			return true
		}
		if cv[i] < tv[i] {
			return false
		}
	}
	return false
}

func parseSemverTriple(v string) ([3]int, bool) {
	var out [3]int
	base := strings.TrimPrefix(strings.TrimSpace(v), "v")
	parts := strings.SplitN(base, ".", 3)
	if len(parts) < 3 {
		return out, false
	}
	for i := 0; i < 3; i++ {
		n := 0
		for _, c := range parts[i] {
			if c < '0' || c > '9' {
				break
			}
			n = n*10 + int(c-'0')
		}
		if len(parts[i]) == 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
