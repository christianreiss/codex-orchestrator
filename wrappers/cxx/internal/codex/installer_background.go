package codex

import (
	"context"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/enginestore"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/installspace"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/libcselect"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/updateprogress"
	"log/slog"
	"os"
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
// full tick and no live process runs from it. A pre-install shortage may invoke
// the same protected sweep before this installer creates or publishes a stage.
func EnsureCodexBackground(ctx context.Context, target string, enforceExact bool, logger *slog.Logger) error {
	if runtime.GOOS != "linux" || strings.TrimSpace(os.Getenv("CDX_CODEX_BIN")) != "" {
		return ensureCodexBackground(ctx, target, enforceExact, logger)
	}
	root, err := ManagedCodexRoot()
	if err != nil {
		return err
	}
	version := strings.TrimPrefix(strings.TrimPrefix(target, "rust-"), "v")
	current := func() (string, string) { p, _ := FindCLI(); return p, strings.TrimSpace(Version(ctx)) }
	var resolved *Release
	if version == "" || version == "latest" {
		version = "latest"
		ctx = libcselect.WithResolver(ctx, func(resolveCtx context.Context) (string, error) {
			rel, e := fetchRelease(resolveCtx, target)
			if e != nil {
				return "", e
			}
			_, installed := current()
			if !enforceExact && installed != "" && installed != "unknown" && semverGT(installed, releaseVersion(rel)) {
				return installed, nil
			}
			resolved = &rel
			return releaseVersion(rel), nil
		})
	} else {
		_, installed := current()
		if !enforceExact && installed != "" && installed != "unknown" && installed != version && !semverGT(version, installed) {
			return nil
		}
	}
	ctx = libcselect.WithHealth(ctx, codexInstallationHealthy)
	return libcselect.Run(ctx, root, version, current, func(attempt context.Context) error {
		if resolved != nil {
			attempt = context.WithValue(attempt, reconcileReleaseKey{}, *resolved)
		}
		return ensureCodexBackground(attempt, libcselect.Target(attempt), enforceExact, logger)
	}, logger)
}

func ensureCodexBackground(ctx context.Context, target string, enforceExact bool, logger *slog.Logger) (retErr error) {
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
	ctx, releaseSpace, err := installspace.Lock(ctx)
	if err != nil {
		return err
	}
	defer releaseSpace()
	defer func() { retErr = installspace.WriteError("Codex", root, retErr) }()
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	currentCtx, currentCancel := context.WithTimeout(ctx, 5*time.Second)
	current := strings.TrimSpace(Version(currentCtx))
	currentCancel()
	rel, err := releaseForReconcile(ctx, target)
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
	if current == version && !libcselect.Attempting(ctx) {
		if cli, err := FindCLI(); err == nil && strings.HasPrefix(cli, root+string(os.PathSeparator)) && codexInstallationHealthy(cli) {
			return nil
		}
	}
	fullPackage, err := pickPackageAsset(ctx, rel)
	if err != nil {
		return err
	}
	var asset, companion Asset
	var temporary, expanded uint64
	artifact := ""
	if fullPackage.Name != "" {
		asset = fullPackage
		temporary = installspace.Size(asset.Size, installspace.Wrapper)
		expanded = maxPackageBytes
		artifact = asset.Name + ":" + asset.Digest
	} else {
		asset, err = pickAssetForLibc(ctx, rel, "codex")
		if err != nil {
			return err
		}
		companion, err = pickAssetForLibc(ctx, rel, codeModeHostBinName)
		if err != nil {
			return fmt.Errorf("Codex %s companion: %w", version, err)
		}
		var companionTemporary, companionExpanded uint64
		temporary, expanded = releaseAssetSpace(asset)
		companionTemporary, companionExpanded = releaseAssetSpace(companion)
		temporary = max(temporary, companionTemporary)
		expanded += companionExpanded
		artifact = asset.Name + ":" + asset.Digest + "/" + companion.Name + ":" + companion.Digest
	}
	// Cleanup runs before taking the engine installer lock.
	if err := installspace.Ensure(ctx, "Codex", func() error { _, err := PruneEngineStoreForInstall(logger); return err }, installspace.Need{Path: root, Bytes: expanded, Inodes: maxPackageFiles},
		installspace.Need{Path: os.TempDir(), Bytes: temporary, Inodes: 128}); err != nil {
		return err
	}
	// Only maintenance writers contend on this lock. Foreground lookup and
	// launch never acquire it, including while downloads are slow or offline.
	lock, err := ipc.TryAcquireExclusivePath(filepath.Join(root, codexInstallLock))
	if err != nil {
		return fmt.Errorf("Codex background installer: %w", err)
	}
	defer lock.Release()

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
	if fullPackage.Name != "" {
		if err := installCodexPackage(ctx, rel, fullPackage, dir, logger); err != nil {
			return err
		}
		cli = filepath.Join(dir, "bin", "codex")
	} else {
		if err := installVerifiedReleaseAsset(ctx, rel, asset, "codex", cli, logger); err != nil {
			return err
		}
		if err := installVerifiedReleaseAsset(ctx, rel, companion, codeModeHostBinName, filepath.Join(dir, codeModeHostBinName), logger); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, standaloneReceipt), []byte("v1\n"), 0600); err != nil {
			return err
		}
	}
	companionPath := filepath.Join(filepath.Dir(cli), codeModeHostBinName)
	updateprogress.Emit(ctx, updateprogress.Event{Phase: "verifying"})
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := libcselect.Probe(probeCtx, cli, "--version")
	if err != nil {
		return fmt.Errorf("validate staged Codex: %w", err)
	}
	if actual := versionTokenRE.FindString(string(out)); actual != version {
		return fmt.Errorf("staged Codex version %q does not match %s", actual, version)
	}
	// Upstream code-mode-host (rust-v0.153.4) parses clap CLI arguments before
	// creating transports; --help validates execution without opening a listener.
	if _, err := libcselect.Probe(probeCtx, companionPath, "--help"); err != nil {
		return fmt.Errorf("validate staged Codex companion: %w", err)
	}
	if err := libcselect.Publication(ctx, cli, artifact); err != nil {
		return err
	}

	if ctx.Err() != nil {
		return ctx.Err()
	}
	// Rename may succeed before the cache's directory sync reports an error.
	// From this point the selected path is uncertain, so keep the validated
	// prefix even if publication fails; a concurrent launch may already use it.
	// The next sweep reclaims whichever prefix the pointer did not select.
	if err := enginestore.InvalidatePressureAdmission(root); err != nil {
		return fmt.Errorf("invalidate pressure-cleanup admission: %w", err)
	}
	published = true
	if err := cacheCodexContext(ctx, cli); err != nil {
		return fmt.Errorf("publish staged Codex: %w", err)
	}
	logger.Info("Codex background update ready for new sessions", "version", version)
	return nil
}

type reconcileReleaseKey struct{}

func releaseForReconcile(ctx context.Context, target string) (Release, error) {
	if rel, ok := ctx.Value(reconcileReleaseKey{}).(Release); ok {
		return rel, nil
	}
	return fetchRelease(ctx, target)
}
