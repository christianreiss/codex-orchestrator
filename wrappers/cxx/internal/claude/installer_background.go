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
	"syscall"
	"time"
)

// ErrClaudeCLIOverride tells maintenance that the operator owns CLI selection.
// Publishing another cache entry would not change the executable FindCLI uses.
var ErrClaudeCLIOverride = errors.New("CLX_CLAUDE_BIN selects an operator-managed Claude CLI")

func managedClaudeRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".cxx", "engines", "claude"), nil
}

func isManagedClaudeCLI(cli string) bool {
	if cli == "" {
		return false
	}
	root, err := managedClaudeRoot()
	if err != nil {
		return false
	}
	// npm's .bin entry is a symlink into the same private version prefix.
	if resolved, err := filepath.EvalSymlinks(cli); err == nil {
		cli = resolved
	}
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}
	rel, err := filepath.Rel(root, cli)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

func managedClaudeEnv(cli string, env []string) []string {
	if env == nil {
		env = os.Environ()
	}
	// Every clx-launched process delegates automatic binary work to fleet
	// maintenance, including an already-current CLI on the operator's PATH.
	env = filterEnv(env, []string{"DISABLE_AUTOUPDATER"})
	env = append(env, "DISABLE_AUTOUPDATER=1")
	if isManagedClaudeCLI(cli) {
		env = filterEnv(env, []string{"DISABLE_UPDATES"})
		env = append(env, "DISABLE_UPDATES=1")
	}
	return env
}

// EnsureClaudeBackground installs only inside a fresh private npm prefix. It
// never invokes a system package manager, sudo, or a global npm install. Cache
// publication is atomic after an exact runnable-version check.
//
// It never reclaims the prefix it supersedes -- an existing process may still
// lazily load its files. Reclaiming is PruneEngineStore's job, from a later
// maintenance tick: the fleet keeps exactly one version on disk, but only once
// the superseded prefix has not been the pointer target for a full tick and no
// live process runs from it.
func EnsureClaudeBackground(ctx context.Context, target string, enforceExact bool, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}
	if strings.TrimSpace(os.Getenv("CLX_CLAUDE_BIN")) != "" {
		return ErrClaudeCLIOverride
	}
	target = strings.TrimSpace(target)
	if target == "" || versionTokenRE.FindString(target) != target {
		return fmt.Errorf("background Claude install requires an exact version, got %q", target)
	}
	root, err := managedClaudeRoot()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return fmt.Errorf("create managed Claude directory: %w", err)
	}
	unlock, err := lockClaudeInstall(ctx, filepath.Join(root, "install.lock"))
	if err != nil {
		return err
	}
	defer unlock()

	current := strings.TrimSpace(Version(ctx))
	if current == target || (!enforceExact && IsDowngrade(current, target)) {
		return nil
	}
	npm, err := exec.LookPath("npm")
	if err != nil {
		return errors.New("managed Claude CLI install requires npm on PATH, and none was found; install Node.js and npm (e.g. the `nodejs` and `npm` packages), then rerun `clx cron run`")
	}
	stage, err := os.MkdirTemp(root, target+"-")
	if err != nil {
		return fmt.Errorf("create Claude install stage: %w", err)
	}
	published := false
	defer func() {
		if !published {
			_ = os.RemoveAll(stage)
		}
	}()
	spec := "@anthropic-ai/claude-code@" + target
	cmd := exec.CommandContext(ctx, npm, "install", "--prefix", stage, "--no-save", "--no-audit", "--no-fund", spec)
	cmd.Dir = stage
	// Explicit --prefix scopes package writes; --global=false neutralizes an
	// inherited npm global setting without changing the operator's npmrc.
	cmd.Args = append(cmd.Args, "--global=false")
	output := newRingBuffer(32 << 10)
	cmd.Stdout, cmd.Stderr = output, output
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("staged npm install %s failed: %w: %s", spec, err, strings.TrimSpace(string(output.Bytes())))
	}
	candidate := runnableStagedClaude(ctx, stage, target)
	if candidate == "" {
		logger.Warn("staged Claude package has no runnable CLI; retrying its postinstall", "target", target)
		if err := runStagedClaudePostinstall(ctx, stage); err != nil {
			return fmt.Errorf("staged Claude postinstall recovery: %w", err)
		}
		candidate = runnableStagedClaude(ctx, stage, target)
	}
	if candidate == "" {
		return fmt.Errorf("staged Claude package did not produce runnable version %s", target)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Cache publication may rename successfully and then fail its directory
	// durability flush. Once validation succeeds, this function never removes a
	// prefix that a newly started process might already have selected; the next
	// sweep reclaims whichever prefix the pointer did not select.
	published = true
	if err := cacheClaudeContext(ctx, candidate); err != nil {
		return fmt.Errorf("publish staged Claude CLI: %w", err)
	}
	logger.Info("published staged Claude CLI", "version", target)
	return nil
}

func runnableStagedClaude(ctx context.Context, stage, target string) string {
	root := filepath.Join(stage, "node_modules")
	for _, candidate := range []string{
		filepath.Join(root, ".bin", "claude"),
		filepath.Join(root, ".bin", "claude-code"),
		filepath.Join(root, "@anthropic-ai", "claude-code", "bin", "claude.exe"),
		filepath.Join(root, "@anthropic-ai", "claude-code", "bin", "claude"),
	} {
		resolved, err := filepath.EvalSymlinks(candidate)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(stage, resolved)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			continue
		}
		probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		version := versionFromCLI(probeCtx, resolved)
		cancel()
		if version == target {
			return resolved
		}
	}
	return ""
}

func runStagedClaudePostinstall(ctx context.Context, stage string) error {
	node, err := exec.LookPath("node")
	if err != nil {
		return errors.New("node is not available on PATH")
	}
	packageDir := filepath.Join(stage, "node_modules", "@anthropic-ai", "claude-code")
	script := filepath.Join(packageDir, "install.cjs")
	if _, err := os.Stat(script); err != nil {
		return fmt.Errorf("locate package postinstall: %w", err)
	}
	cmd := exec.CommandContext(ctx, node, script)
	cmd.Dir = packageDir
	output := newRingBuffer(32 << 10)
	cmd.Stdout, cmd.Stderr = output, output
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("run package postinstall: %w: %s", err, strings.TrimSpace(string(output.Bytes())))
	}
	return nil
}

// The long install.lock serializes installers only. The separate claude-bin
// cache lock is held only for atomic publication; PATH discovery uses a
// nonblocking attempt, so no launch waits behind either operation.
func lockClaudeInstall(ctx context.Context, path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	for {
		if err := ctx.Err(); err != nil {
			_ = f.Close()
			return nil, err
		}
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { _ = f.Close() }, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			_ = f.Close()
			return nil, err
		}
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			_ = f.Close()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}
