package peer

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/ui"
	coreupdate "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
)

const peerEngine = "claude"
const peerName = "clx"
const peerEngineCLI = "claude"

// peerSpawnEnv guards against reconcile ping-pong: when a wrapper spawns the
// peer's `--cron run`, the peer must not reconcile back into us. Same name in
// both wrappers.
const peerSpawnEnv = "CODEX_ORCH_PEER_SPAWN"
const coordinatedCronEnv = "CXX_CRON_COORDINATED"

// errPeerEngineDisabled is returned by fetchBundle when the server reports the
// peer engine is not enabled for this host (HTTP 403 engine_disabled). The cron
// path treats it as a clean "no peer engine" skip rather than an error.
var errPeerEngineDisabled = fleetconfig.ErrEngineDisabled
var legacyPeerCronPath = "/etc/cron.d/clx-managed"

func Reconcile(ctx context.Context, cfg *config.Config, auth *orchestrator.AuthRetrieveResponse, minimal bool, logger *slog.Logger) {
	engines, ok := desiredEngines(cfg, auth)
	if !ok {
		return
	}
	if hasEngine(engines, peerEngine) {
		if err := installPeer(ctx, cfg, false, minimal); err != nil {
			logger.Warn("peer wrapper install skipped", "engine", peerEngine, "err", err)
		}
		return
	}
	if err := removePeer(ctx, logger); err != nil {
		logger.Warn("peer wrapper removal skipped", "engine", peerEngine, "err", err)
	}
}

// EnsureForCron is the cron-tick variant of Reconcile: it installs/updates the
// peer wrapper and engine when the host config says the peer engine is desired,
// but never removes anything — removal stays on the interactive path where a
// fresh server-provided engines list is available (a stale local config must
// not be able to wipe the peer's home directories from an unattended tick).
func EnsureForCron(ctx context.Context, cfg *config.Config, minimal bool, logger *slog.Logger) {
	if os.Getenv(peerSpawnEnv) == "1" || os.Getenv(coordinatedCronEnv) == "1" {
		return
	}
	// Authoritative engine state lives on the server. The locally-cached config
	// (cfg.Host.Engines) can be stale when an operator enables the peer engine
	// after this host was installed; gating on it here used to leave the peer
	// wrapper unprovisioned on cron-only hosts. Ask the server instead: a served
	// bundle means the peer engine is enabled, a 403 (engine_disabled) means it
	// is not — skip silently then. As with interactive Reconcile we never
	// persist the engines list locally and never remove the peer from an
	// unattended tick.
	if err := installPeer(ctx, cfg, true, minimal); err != nil {
		if errors.Is(err, errPeerEngineDisabled) {
			return
		}
		logger.Warn("peer wrapper cron ensure skipped", "engine", peerEngine, "err", err)
	}
}

func desiredEngines(cfg *config.Config, auth *orchestrator.AuthRetrieveResponse) ([]string, bool) {
	if auth != nil && auth.Host != nil {
		if len(auth.Host.EnginesList) > 0 {
			return auth.Host.EnginesList, true
		}
		if strings.TrimSpace(auth.Host.Engines) != "" {
			return splitEngines(auth.Host.Engines), true
		}
	}
	if cfg != nil {
		if len(cfg.Host.EnginesList) > 0 {
			return cfg.Host.EnginesList, true
		}
		if strings.TrimSpace(cfg.Host.Engines) != "" {
			return splitEngines(cfg.Host.Engines), true
		}
	}
	return nil, false
}

func splitEngines(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if v := strings.TrimSpace(strings.ToLower(part)); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func hasEngine(engines []string, want string) bool {
	for _, e := range engines {
		if strings.EqualFold(strings.TrimSpace(e), want) {
			return true
		}
	}
	return false
}

func installPeer(ctx context.Context, cfg *config.Config, forceCronTick, minimal bool) error {
	fetched, err := fleetconfig.Fetch(ctx, cfg, peerEngine)
	if err != nil {
		return err
	}
	if err := fleetconfig.Persist(ctx, fetched); err != nil {
		return err
	}
	peerCfg := fetched.Config
	sum := peerCfg.Wrapper.BinarySHA256
	installed := false
	source, current := matchingCommonBinary(sum)
	if !current {
		caps := updateCaps(cfg, minimal)
		fmt.Fprintln(os.Stderr, ui.UpdateProgress(caps, "cdx", peerName, "", ""))
		source, err = coreupdate.Install(ctx, peerCfg, peerCfg.Wrapper.BinaryURL, sum, peerCfg.Wrapper.Version, slog.Default())
		if err != nil {
			fmt.Fprintln(os.Stderr, ui.UpdateFailure(caps, "cdx", peerName, "", err))
			return err
		}
		fmt.Fprintln(os.Stderr, ui.UpdateComplete(caps, "cdx", peerName, "", false))
		installed = true
	}
	if _, err := layout.EnsureAliasesForSHA(ctx, source, []string{layout.EngineCodex, layout.EngineClaude}, sum); err != nil {
		return fmt.Errorf("reconcile cxx aliases: %w", err)
	}
	// Interactive launches keep this lightweight and only run the peer tick when
	// the peer was just installed or its engine CLI is missing. Cron forces the
	// guarded peer tick so a single managed cdx cron entry refreshes clx and
	// claude too.
	if os.Getenv(coordinatedCronEnv) != "1" && shouldRunPeerCronTick(installed, peerEngineCLIPresent(), forceCronTick) {
		runPeerCronTick(ctx, minimal)
	}
	return nil
}

func updateCaps(cfg *config.Config, minimal bool) ui.Caps {
	theme := ""
	if cfg != nil && cfg.EngineOptions.AdminThemeHint != nil {
		theme = *cfg.EngineOptions.AdminThemeHint
	}
	caps := ui.DetectCaps(theme)
	if minimal {
		return ui.MinimalCaps(caps)
	}
	return caps
}

func shouldRunPeerCronTick(installed, enginePresent, force bool) bool {
	return force || installed || !enginePresent
}

func matchingCommonBinary(expected string) (string, bool) {
	for _, p := range canonicalBinaryCandidates() {
		fi, err := os.Stat(p)
		if err != nil || fi.IsDir() {
			continue
		}
		if verifySHA256(p, expected) == nil {
			return p, true
		}
	}
	return "", false
}

func peerEngineCLIPresent() bool {
	_, err := exec.LookPath(peerEngineCLI)
	return err == nil
}

func runPeerCronTick(ctx context.Context, minimal bool) {
	tctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	args := []string{"--cron", "run"}
	if minimal {
		args = append(args, "--minimal")
	}
	cmd := exec.CommandContext(tctx, peerBinaryPath(), args...)
	cmd.Env = append(os.Environ(), peerSpawnEnv+"=1")
	_ = cmd.Run()
}

func peerConfigPath() string {
	if env := strings.TrimSpace(os.Getenv("CLX_CONFIG_PATH")); env != "" {
		return env
	}
	if xdg := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); xdg != "" {
		return filepath.Join(xdg, "codex-orchestrator", "clx.json")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		// Without a resolvable home directory we must not fall back to a
		// relative path: that would read/write ".config/..." under whatever
		// directory the process happens to be launched from.
		return filepath.Join(os.TempDir(), "codex-orchestrator-no-home", "clx.json")
	}
	return filepath.Join(home, ".config", "codex-orchestrator", "clx.json")
}

func canonicalBinaryCandidates() []string {
	out := peerBinaryCandidates()
	if exe, err := os.Executable(); err == nil {
		out = append(out, exe)
	}
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if dir != "" {
			out = append(out, filepath.Join(dir, "cxx"))
		}
	}
	return out
}

func peerBinaryPath() string {
	if p, err := exec.LookPath(peerName); err == nil && p != "" {
		return p
	}
	// Look up the cdx shim in PATH rather than os.Executable(): in shim mode
	// os.Executable() resolves to the data-dir binary, not the PATH-visible shim.
	if cdx, err := exec.LookPath("cdx"); err == nil && cdx != "" {
		return filepath.Join(filepath.Dir(cdx), peerName)
	}
	return filepath.Join("/usr/local/bin", peerName)
}

func peerBinaryCandidates() []string {
	var out []string
	seen := make(map[string]struct{})
	add := func(p string) {
		if p == "" {
			return
		}
		if _, ok := seen[p]; ok {
			return
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if dir == "" {
			continue
		}
		add(filepath.Join(dir, peerName))
	}
	if cdx, err := exec.LookPath("cdx"); err == nil && cdx != "" {
		add(filepath.Join(filepath.Dir(cdx), peerName))
	}
	add(filepath.Join("/usr/local/bin", peerName))
	add(filepath.Join("/usr/local/sbin", peerName))
	return out
}

func verifySHA256(path, expected string) error {
	return coreupdate.VerifyChecksum(path, expected)
}

func removePeer(ctx context.Context, logger *slog.Logger) error {
	configPath := peerConfigPath()
	for _, path := range []string{configPath, configPath + ".sig"} {
		removeFilePath(path, logger)
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		// Without a resolvable home directory, filepath.Join(home, ...) would
		// silently produce relative paths (e.g. ".claude/settings.json") that
		// os.RemoveAll would then delete relative to the process's current
		// working directory instead of failing loudly.
		logger.Warn("peer remove skipped home-relative paths: no home directory", "err", err)
	} else {
		for _, path := range []string{
			filepath.Join(home, ".claude", "settings.json"),
			filepath.Join(home, ".claude", "CLAUDE.md"),
			filepath.Join(home, ".claude", ".credentials.json"),
		} {
			removeFilePath(path, logger)
		}
		removeTreePath(filepath.Join(home, ".clx"), logger)
	}
	if npmGlobalHas(ctx, "@anthropic-ai/claude-code") {
		_ = exec.CommandContext(ctx, "npm", "uninstall", "-g", "@anthropic-ai/claude-code").Run()
	}
	removeFilePath(legacyPeerCronPath, logger)
	peerPath := peerBinaryPath()
	if target, err := os.Readlink(peerPath); err == nil && target == "cxx" {
		if err := layout.RemoveAlias(ctx, filepath.Dir(peerPath), peerEngine); err != nil {
			logger.Warn("peer alias removal skipped", "path", peerPath, "err", err)
		}
	} else {
		removeFilePath(peerPath, logger)
	}
	return nil
}

func removeFilePath(path string, logger *slog.Logger) {
	if path == "" || filepath.Clean(path) == string(filepath.Separator) {
		return
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		if _, ok := err.(*os.PathError); ok {
			if sudoRemoveFile(path) == nil {
				return
			}
		}
		logger.Warn("peer remove skipped", "path", path, "err", err)
	}
}

func removeTreePath(path string, logger *slog.Logger) {
	if path == "" || filepath.Clean(path) == string(filepath.Separator) {
		return
	}
	if err := os.RemoveAll(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		if _, ok := err.(*os.PathError); ok {
			if sudoRemoveTree(path) == nil {
				return
			}
		}
		logger.Warn("peer remove skipped", "path", path, "err", err)
	}
}

func sudoRemoveFile(path string) error {
	if _, err := exec.LookPath("sudo"); err != nil {
		return err
	}
	return exec.Command("sudo", "-n", "rm", "-f", path).Run()
}

func sudoRemoveTree(path string) error {
	if _, err := exec.LookPath("sudo"); err != nil {
		return err
	}
	return exec.Command("sudo", "-n", "rm", "-rf", path).Run()
}

func npmGlobalHas(ctx context.Context, pkg string) bool {
	if _, err := exec.LookPath("npm"); err != nil {
		return false
	}
	return exec.CommandContext(ctx, "npm", "ls", "-g", "--depth=0", pkg).Run() == nil
}
