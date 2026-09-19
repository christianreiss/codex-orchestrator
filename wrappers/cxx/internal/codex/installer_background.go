package codex

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

// EnsureCodexBackground prepares a private release while existing sessions keep
// their executable and sibling companion. Publication changes only the cached
// path used by future launches, so a running session is never disturbed.
//
// It never reclaims the prefix it supersedes. That is PruneEngineStore's job,
// from a later maintenance tick: the fleet keeps exactly one version on disk,
// but only once the superseded prefix has not been the pointer target for a
// full tick and no live process runs from it.
func EnsureCodexBackground(ctx context.Context, target string, enforceExact bool, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}
	if strings.TrimSpace(os.Getenv("CDX_CODEX_BIN")) != "" {
		return fmt.Errorf("background Codex update cannot replace CDX_CODEX_BIN; update that explicit CLI or unset the override")
	}
	root, err := ManagedCodexRoot()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	// Only maintenance writers contend on this lock. Foreground lookup and
	// launch never acquire it, including while downloads are slow or offline.
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(root, codexInstallLock))
	if err != nil {
		return fmt.Errorf("Codex background installer: %w", err)
	}
	defer lock.Release()
	currentCtx, currentCancel := context.WithTimeout(ctx, 5*time.Second)
	current := strings.TrimSpace(Version(currentCtx))
	currentCancel()
	rel, err := fetchRelease(ctx, target)
	if err != nil {
		return err
	}
	version := releaseVersion(rel)
	if version == "" {
		return fmt.Errorf("Codex release %q has no version", rel.TagName)
	}
	requested := strings.TrimPrefix(strings.TrimPrefix(target, "rust-"), "v")
	if target != "" && target != "latest" && requested != version {
		return fmt.Errorf("Codex release version %s does not match requested %s", version, target)
	}
	if !enforceExact && current != "" && current != "unknown" && current != version && !semverGT(version, current) {
		return nil
	}
	if current == version {
		if cli, err := FindCLI(); err == nil && strings.HasPrefix(cli, root+string(os.PathSeparator)) {
			if info, err := os.Stat(filepath.Join(filepath.Dir(cli), codeModeHostBinName)); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 && info.Size() > 0 {
				return nil
			}
		}
	}
	asset, err := pickAsset(rel, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return err
	}
	companion, err := pickAssetFor(rel, codeModeHostBinName, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return fmt.Errorf("Codex %s companion: %w", version, err)
	}
	dir, err := os.MkdirTemp(root, version+"-")
	if err != nil {
		return err
	}
	published := false
	defer func() {
		if !published {
			_ = os.RemoveAll(dir)
		}
	}()
	cli := filepath.Join(dir, "codex")
	if err := installVerifiedReleaseAsset(ctx, rel, asset, "codex", cli, logger); err != nil {
		return err
	}
	companionPath := filepath.Join(dir, codeModeHostBinName)
	if err := installVerifiedReleaseAsset(ctx, rel, companion, codeModeHostBinName, companionPath, logger); err != nil {
		return err
	}
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(probeCtx, cli, "--version").Output()
	if err != nil {
		return fmt.Errorf("validate staged Codex: %w", err)
	}
	if actual := versionTokenRE.FindString(string(out)); actual != version {
		return fmt.Errorf("staged Codex version %q does not match %s", actual, version)
	}
	// Upstream code-mode-host (rust-v0.153.4) parses clap CLI arguments before
	// creating transports; --help validates execution without opening a listener.
	probe := exec.CommandContext(probeCtx, companionPath, "--help")
	probe.Stdout, probe.Stderr = io.Discard, io.Discard
	if err := probe.Run(); err != nil {
		return fmt.Errorf("validate staged Codex companion: %w", err)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	// Rename may succeed before the cache's directory sync reports an error.
	// From this point the selected path is uncertain, so keep the validated
	// prefix even if publication fails; a concurrent launch may already use it.
	// The next sweep reclaims whichever prefix the pointer did not select.
	published = true
	if err := cacheCodexContext(ctx, cli); err != nil {
		return fmt.Errorf("publish staged Codex: %w", err)
	}
	logger.Info("Codex background update ready for new sessions", "version", version)
	return nil
}
