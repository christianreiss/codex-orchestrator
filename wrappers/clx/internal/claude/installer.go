// Package claude includes installer.go which installs or updates the
// `@anthropic-ai/claude-code` npm package. Unlike cdx, there is no GitHub
// release pipeline for the Claude CLI — npm-global is the only path.
package claude

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
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
	if !enforceExact && current != "" && current != "unknown" && target != "" && current == target {
		logger.Debug("EnsureClaude: already at target", "version", current)
		return nil
	}

	spec := "@anthropic-ai/claude-code"
	if target != "" && target != "latest" {
		spec = "@anthropic-ai/claude-code@" + target
	}
	logger.Info("EnsureClaude: npm install", "spec", spec, "enforce_exact", enforceExact)

	args := []string{"install", "-g", spec}
	cmd := exec.CommandContext(ctx, "npm", args...)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	if isPermErr(out, err) {
		if _, lerr := exec.LookPath("sudo"); lerr == nil {
			logger.Info("EnsureClaude: retrying npm install under sudo -n")
			sudoArgs := append([]string{"-n", "npm"}, args...)
			cmd = exec.CommandContext(ctx, "sudo", sudoArgs...)
			out2, serr := cmd.CombinedOutput()
			if serr == nil {
				return nil
			}
			return fmt.Errorf("npm install %s failed under sudo: %w: %s", spec, serr, strings.TrimSpace(string(out2)))
		}
	}
	return fmt.Errorf("npm install %s failed: %w: %s", spec, err, strings.TrimSpace(string(out)))
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
