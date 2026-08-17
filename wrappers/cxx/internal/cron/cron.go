// Package cron owns the single host-wide cxx maintenance schedule. Engine
// ticks remain engine-aware, but cdx/clx cron commands both enter this one
// coordinator so a dual-engine host has one schedule and one wrapper update.
package cron

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentbus"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	coreupdate "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
)

const (
	Marker            = "# cxx-managed-cron"
	EngineOnlyEnv     = "CXX_CRON_ENGINE_ONLY"
	CoordinatedEnv    = "CXX_CRON_COORDINATED"
	systemCronPath    = "/etc/cron.d/cxx-managed"
	cronPATHEnv       = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	coordinatorTimout = 12 * time.Minute
)

// IsCoordinated reports whether a persona tick is running under the shared
// host coordinator. This keeps the coordination knob owned in one package.
func IsCoordinated() bool { return os.Getenv(CoordinatedEnv) == "1" }

var legacyMarkers = []string{"# cdx-managed-cron", "# clx-managed-cron"}
var legacySystemPaths = []string{"/etc/cron.d/cdx-managed", "/etc/cron.d/clx-managed"}
var userCrontabSpoolDirs = []string{
	"/var/spool/cron",
	"/var/spool/cron/crontabs",
	"/var/at/tabs",
	"/var/cron/tabs",
	"/usr/lib/cron/tabs",
}

type userCrontabChange struct {
	user     string
	original string
}

type userCrontabRollback func() error

var (
	fetchAuthoritative     = fleetconfig.Fetch
	persistAuthoritative   = fleetconfig.Persist
	removeEngineConfig     = fleetconfig.Remove
	runEngineTick          = defaultRunEngineTick
	installSystemSchedule  = installSystemCron
	reconcileUserSchedules = reconcileManagedUserCrontabs
	removeLegacySchedules  = removeLegacySystemSchedules
	removeSystemSchedule   = removeSystemFile
	discoverCrontabOwners  = discoverManagedCrontabOwners
	readUserCrontab        = readCrontabForUser
	writeUserCrontab       = writeCrontabForUser
	lookupCrontabUser      = user.Lookup
	currentCrontabUser     = user.Current
	resolveCronIdentity    = resolveSystemCronIdentity
	ensureAgentService     = agentbus.EnsureService
)

// Install reconciles aliases first, then writes exactly one cxx schedule and
// removes both legacy persona schedules. cfg is a verified seed config.
func Install(ctx context.Context, cfg *config.Config) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	_, _, canonical, err := refreshAuthoritative(ctx, cfg, exe)
	if err != nil {
		return err
	}
	return reconcileSchedule(ctx, canonical)
}

// Remove deletes the shared schedule and all historical persona schedules.
// It intentionally does not touch aliases, configs, auth, or native CLIs.
func Remove(ctx context.Context) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	canonical, err := layout.CanonicalExecutable(exe)
	if err != nil {
		return err
	}
	return layout.WithTargetLock(ctx, canonical, func() error {
		return removeSchedulesLocked(os.Geteuid() == 0 || passwordlessSudo())
	})
}

func removeSchedulesLocked(allUsers bool) error {
	rollbackUsers := userCrontabRollback(func() error { return nil })
	if allUsers {
		var err error
		rollbackUsers, err = reconcileUserSchedules()
		if err != nil {
			return err
		}
		if rollbackUsers == nil {
			rollbackUsers = func() error { return nil }
		}
	} else if err := stripUserManaged(); err != nil {
		return err
	}

	var errs []error
	for _, path := range append([]string{systemCronPath}, legacySystemPaths...) {
		if err := removeSystemSchedule(path); err != nil {
			errs = append(errs, err)
		}
	}
	if cleanupErr := errors.Join(errs...); cleanupErr != nil {
		if allUsers {
			return errors.Join(cleanupErr, rollbackUsers())
		}
		return cleanupErr
	}
	return nil
}

// Run verifies every enabled signed config targets the same cxx bytes, then
// executes each persona tick once in a deterministic order. Child ticks are
// marked engine-only so alias forwarding cannot recurse.
func Run(ctx context.Context, seed *config.Config, minimal bool, stdout, stderr io.Writer) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	configs, engines, canonical, err := refreshAuthoritative(ctx, seed, exe)
	if err != nil {
		return err
	}
	// A legacy cdx/clx schedule reaches this path first. Collapse both old
	// markers/files into the one cxx schedule before any child tick can recurse.
	if err := reconcileSchedule(ctx, canonical); err != nil {
		return fmt.Errorf("reconcile cxx cron schedule: %w", err)
	}
	if backgroundWorkerRequired(configs) {
		// Service managers are not uniformly available in SSH/headless user
		// contexts. Keep maintenance successful and surface the exact retry.
		// Claude auth rotation coverage must not depend on agent messaging being
		// enabled: detached native daemons write the same credential file. Ensure
		// it before the engine ticks so a failed auth tick cannot prevent healing.
		if err := ensureAgentService(stdout, stderr); err != nil {
			fmt.Fprintln(stderr, "cxx background worker service unavailable:", err)
		}
	}
	runCtx, cancel := context.WithTimeout(ctx, coordinatorTimout)
	defer cancel()
	if err := runEnabledTicks(runCtx, canonical, engines, minimal, stdout, stderr); err != nil {
		return err
	}
	return nil
}

func backgroundWorkerRequired(configs []*config.Config) bool {
	for _, cfg := range configs {
		if cfg != nil && (cfg.Engine == config.EngineClaude || cfg.AgentMessaging.Enabled) {
			return true
		}
	}
	return false
}

func runEnabledTicks(ctx context.Context, canonical string, engines []string, minimal bool, stdout, stderr io.Writer) error {
	var errs []error
	for _, engine := range engines {
		args := []string{engine, "--cron", "run"}
		if minimal {
			args = append(args, "--minimal")
		}
		env := setEnv(setEnv(os.Environ(), EngineOnlyEnv, "1"), CoordinatedEnv, "1")
		if err := runEngineTick(ctx, canonical, args, env, stdout, stderr); err != nil {
			errs = append(errs, fmt.Errorf("%s maintenance tick: %w", engine, err))
		}
	}
	return errors.Join(errs...)
}

func defaultRunEngineTick(ctx context.Context, canonical string, args, env []string, stdout, stderr io.Writer) error {
	cmd := exec.CommandContext(ctx, canonical, args...)
	cmd.Env = env
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return cmd.Run()
}

func IsEngineOnly() bool { return os.Getenv(EngineOnlyEnv) == "1" }

// refreshAuthoritative probes both engines before mutating anything. Only a
// verified 200 enables an engine and only an explicit engine_disabled response
// disables one; transport/auth/signature uncertainty preserves the old layout.
func refreshAuthoritative(ctx context.Context, seed *config.Config, executable string) ([]*config.Config, []string, string, error) {
	if seed == nil {
		var err error
		seed, err = loadAnySeedConfig()
		if err != nil {
			return nil, nil, "", err
		}
	}
	fetched := make(map[string]*fleetconfig.Fetched, 2)
	var disabled []string
	for _, engine := range []string{config.EngineCodex, config.EngineClaude} {
		item, err := fetchAuthoritative(ctx, seed, engine)
		if errors.Is(err, fleetconfig.ErrEngineDisabled) {
			disabled = append(disabled, engine)
			continue
		}
		if err != nil {
			return nil, nil, "", fmt.Errorf("authoritative %s engine probe: %w", engine, err)
		}
		if item == nil || item.Config == nil {
			return nil, nil, "", fmt.Errorf("authoritative %s engine probe returned an empty config", engine)
		}
		fetched[engine] = item
	}
	if len(fetched) == 0 {
		return nil, nil, "", errors.New("authoritative engine probe returned no enabled engine")
	}
	configs := make([]*config.Config, 0, len(fetched))
	engines := make([]string, 0, len(fetched))
	for _, engine := range []string{config.EngineCodex, config.EngineClaude} {
		item := fetched[engine]
		if item == nil || item.Config == nil {
			continue
		}
		if item.Config.Host.ID != seed.Host.ID || item.Config.Host.FQDN != seed.Host.FQDN {
			return nil, nil, "", fmt.Errorf("authoritative %s config belongs to a different host", engine)
		}
		configs = append(configs, item.Config)
		engines = append(engines, engine)
	}
	// All probes and identity checks succeeded. Persist enabled configs before
	// adding aliases, then remove explicitly disabled config/alias state.
	for _, engine := range engines {
		if err := persistAuthoritative(ctx, fetched[engine]); err != nil {
			return nil, nil, "", fmt.Errorf("persist authoritative %s config: %w", engine, err)
		}
	}
	canonical, err := ensureEnabledAliases(ctx, executable, engines, configs)
	if err != nil {
		return nil, nil, "", err
	}
	for _, engine := range disabled {
		if err := layout.RemoveAlias(ctx, filepath.Dir(canonical), engine); err != nil {
			return nil, nil, "", fmt.Errorf("remove disabled %s alias: %w", engine, err)
		}
		if err := removeEngineConfig(ctx, engine); err != nil {
			return nil, nil, "", fmt.Errorf("remove disabled %s config: %w", engine, err)
		}
	}
	return configs, engines, canonical, nil
}

func ensureEnabledAliases(ctx context.Context, executable string, engines []string, configs []*config.Config) (string, error) {
	for _, cfg := range configs {
		if cfg != nil && coreupdate.VerifyChecksum(executable, cfg.Wrapper.BinarySHA256) == nil {
			return layout.EnsureAliasesForSHA(ctx, executable, engines, cfg.Wrapper.BinarySHA256)
		}
	}
	// A rolling config refresh may advertise bytes newer than the running cxx.
	// The executable is nevertheless a trusted combined binary; let the child
	// tick update it after authoritative alias convergence.
	return layout.EnsureAliases(ctx, executable, engines)
}

func loadAnySeedConfig() (*config.Config, error) {
	pubkey, err := signing.PublicKey()
	if err != nil {
		return nil, err
	}
	return loadAnySeedConfigWithKey(pubkey)
}

// loadAnySeedConfigWithKey picks the seed the authoritative refresh fetches
// with. An expired config is accepted as a last resort: it is still signed, so
// its orchestrator credentials are authentic, and the refresh it seeds is
// exactly what replaces it. Without this, expiry would be unrecoverable — the
// self-heal path needs a seed and the only seed on the host is the expired one.
// The unexpired config of the sibling engine is always preferred, so the fallback
// is a second pass rather than first-match.
func loadAnySeedConfigWithKey(pubkey ed25519.PublicKey) (*config.Config, error) {
	var errs []error
	var expiredSeed *config.Config
	for _, engine := range []string{config.EngineCodex, config.EngineClaude} {
		path, pathErr := config.DefaultPathForEngine(engine)
		if pathErr != nil {
			errs = append(errs, pathErr)
			continue
		}
		cfg, loadErr := config.LoadForEngine(path, pubkey, false, engine)
		if loadErr == nil {
			return cfg, nil
		}
		var expired *config.ExpiredError
		if expiredSeed == nil && errors.As(loadErr, &expired) && expired.Config != nil {
			expiredSeed = expired.Config
		}
		errs = append(errs, loadErr)
	}
	if expiredSeed != nil {
		return expiredSeed, nil
	}
	return nil, fmt.Errorf("no usable signed cxx engine config found: %w", errors.Join(errs...))
}

func loadEnabledConfigs(seed *config.Config) ([]*config.Config, []string, error) {
	pubkey, err := signing.PublicKey()
	if err != nil {
		return nil, nil, err
	}
	byEngine := map[string]*config.Config{}
	if seed != nil {
		byEngine[seed.Engine] = seed
	}
	if seed == nil {
		for _, engine := range []string{config.EngineCodex, config.EngineClaude} {
			path, pathErr := config.DefaultPathForEngine(engine)
			if pathErr != nil {
				continue
			}
			cfg, loadErr := config.LoadForEngine(path, pubkey, false, engine)
			if loadErr == nil {
				byEngine[engine] = cfg
			}
		}
	}
	if len(byEngine) == 0 {
		return nil, nil, errors.New("no usable signed cxx engine config found")
	}
	var first *config.Config
	for _, engine := range []string{config.EngineCodex, config.EngineClaude} {
		if byEngine[engine] != nil {
			first = byEngine[engine]
			break
		}
	}
	engines := config.EnabledEngines(first.Host, first.Engine)
	configs := make([]*config.Config, 0, len(engines))
	for _, engine := range engines {
		cfg := byEngine[engine]
		if cfg == nil {
			path, pathErr := config.DefaultPathForEngine(engine)
			if pathErr != nil {
				return nil, nil, pathErr
			}
			cfg, err = config.LoadForEngine(path, pubkey, false, engine)
			if err != nil {
				return nil, nil, fmt.Errorf("enabled %s config unavailable: %w", engine, err)
			}
			byEngine[engine] = cfg
		}
		configs = append(configs, cfg)
	}
	if err := validateEnabledConfigs(byEngine, first, engines); err != nil {
		return nil, nil, err
	}
	return configs, engines, nil
}

// validateEnabledConfigs checks identity only. Signed wrapper metadata is a
// release hint and may legitimately lag the running cxx or differ briefly
// across engines during a rolling config refresh.
func validateEnabledConfigs(byEngine map[string]*config.Config, first *config.Config, engines []string) error {
	for _, engine := range engines {
		cfg := byEngine[engine]
		if cfg == nil {
			continue
		}
		if cfg.Host.ID != first.Host.ID || cfg.Host.FQDN != first.Host.FQDN {
			return fmt.Errorf("%s config belongs to a different host", engine)
		}
	}
	return nil
}

func installUserCron(bin string, minute, hour int) error {
	cur, err := readCrontab()
	if err != nil {
		return err
	}
	body, _ := stripManagedBody(cur)
	home, _ := os.UserHomeDir()
	logFile := filepath.Join(home, ".cxx", "cron.log")
	if err := os.MkdirAll(filepath.Dir(logFile), 0o700); err != nil {
		return err
	}
	if body != "" && !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	body += buildCronLine(minute, hour, bin, logFile) + "\n"
	return writeCrontab(body)
}

func reconcileSchedule(ctx context.Context, canonical string) error {
	return layout.WithTargetLock(ctx, canonical, func() error {
		host, _ := os.Hostname()
		minute, hour := deterministicTime(host)
		if os.Geteuid() != 0 && canWriteBinary(canonical) {
			if err := installUserCron(canonical, minute, hour); err != nil {
				return err
			}
			var errs []error
			for _, path := range append([]string{systemCronPath}, legacySystemPaths...) {
				if err := removeSystemSchedule(path); err != nil {
					errs = append(errs, err)
				}
			}
			if cleanupErr := errors.Join(errs...); cleanupErr != nil {
				// Do not leave two daily coordinators when an old root-owned
				// schedule cannot be removed. Roll back the new user entry and
				// preserve the existing system schedule.
				return errors.Join(cleanupErr, stripUserManaged())
			}
			return nil
		}
		return reconcileSystemSchedule(canonical, minute, hour)
	})
}

func reconcileSystemSchedule(canonical string, minute, hour int) error {
	if err := installSystemSchedule(canonical, minute, hour); err != nil {
		return err
	}
	rollbackUsers, cleanupErr := reconcileUserSchedules()
	if cleanupErr != nil {
		// User cleanup is transactional internally. The new system entry must
		// not survive if any owner could not be inspected or reconciled.
		return errors.Join(cleanupErr, removeSystemSchedule(systemCronPath))
	}
	if rollbackUsers == nil {
		rollbackUsers = func() error { return nil }
	}
	if cleanupErr = removeLegacySchedules(); cleanupErr != nil {
		// A later legacy-file failure restores every user crontab byte-for-byte
		// before removing the new host-wide entry.
		return errors.Join(cleanupErr, rollbackUsers(), removeSystemSchedule(systemCronPath))
	}
	return nil
}

func installSystemCron(bin string, minute, hour int) error {
	privileged := os.Geteuid() != 0
	if privileged && !passwordlessSudo() {
		return fmt.Errorf("cxx at %s is not writable and passwordless sudo is unavailable", bin)
	}
	identity, err := resolveCronIdentity()
	if err != nil {
		return err
	}
	if err := ensureCronLog(identity.logFile, identity.home); err != nil {
		return fmt.Errorf("prepare cxx cron log: %w", err)
	}
	body := buildSystemCronBody(bin, identity.cdxPath, identity.clxPath, identity.logFile, identity.userName, identity.home, minute, hour)
	return writeManagedFileAtomic(systemCronPath, []byte(body), privileged)
}

type systemCronIdentity struct {
	userName string
	home     string
	cdxPath  string
	clxPath  string
	logFile  string
}

func resolveSystemCronIdentity() (systemCronIdentity, error) {
	userName, home := installUserContext()
	cdxPath, clxPath, err := resolveCronConfigPaths(home)
	if err != nil {
		return systemCronIdentity{}, err
	}
	home = inferConfigHome(home, cdxPath, clxPath)
	userName = inferHomeOwner(userName, home)
	if strings.TrimSpace(userName) == "" {
		userName = "root"
	}
	logFile := filepath.Join(home, ".cxx", "cron.log")
	return systemCronIdentity{
		userName: userName,
		home:     home,
		cdxPath:  cdxPath,
		clxPath:  clxPath,
		logFile:  logFile,
	}, nil
}

func buildSystemCronBody(bin, cdxPath, clxPath, logFile, userName, home string, minute, hour int) string {
	if strings.TrimSpace(userName) == "" {
		userName = "root"
	}
	command := fmt.Sprintf("%s cron run >> %s 2>&1", shellEscape(bin), shellEscape(logFile))
	command = strings.ReplaceAll(command, "%", `\%`)
	return fmt.Sprintf(`# cxx-managed-cron - host-wide wrapper and engine maintenance. Do not edit by hand.
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HOME=%s
CDX_CONFIG_PATH=%s
CLX_CONFIG_PATH=%s
%d %d * * * %s %s
`, shellEscape(home), shellEscape(cdxPath), shellEscape(clxPath), minute, hour, userName, command)
}

func resolveCronConfigPaths(home string) (string, string, error) {
	cdxOverride := strings.TrimSpace(os.Getenv("CDX_CONFIG_PATH"))
	clxOverride := strings.TrimSpace(os.Getenv("CLX_CONFIG_PATH"))
	if cdxOverride != "" && clxOverride == "" {
		clxOverride = filepath.Join(filepath.Dir(cdxOverride), "clx.json")
	}
	if clxOverride != "" && cdxOverride == "" {
		cdxOverride = filepath.Join(filepath.Dir(clxOverride), "cdx.json")
	}
	if cdxOverride == "" {
		if xdg := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); xdg != "" {
			cdxOverride = filepath.Join(xdg, "codex-orchestrator", "cdx.json")
		} else {
			cdxOverride = filepath.Join(home, ".config", "codex-orchestrator", "cdx.json")
		}
	}
	if clxOverride == "" {
		if xdg := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); xdg != "" {
			clxOverride = filepath.Join(xdg, "codex-orchestrator", "clx.json")
		} else {
			clxOverride = filepath.Join(home, ".config", "codex-orchestrator", "clx.json")
		}
	}
	if !filepath.IsAbs(cdxOverride) || !filepath.IsAbs(clxOverride) {
		return "", "", errors.New("cron config paths must be absolute")
	}
	return cdxOverride, clxOverride, nil
}

func inferConfigHome(fallback string, paths ...string) string {
	for _, path := range paths {
		dir := filepath.Dir(path)
		if filepath.Base(dir) == "codex-orchestrator" && filepath.Base(filepath.Dir(dir)) == ".config" {
			return filepath.Dir(filepath.Dir(dir))
		}
	}
	return fallback
}

func inferHomeOwner(fallback, home string) string {
	if os.Geteuid() != 0 || (fallback != "" && fallback != "root") {
		return fallback
	}
	if info, err := os.Stat(home); err == nil {
		if st, ok := info.Sys().(*syscall.Stat_t); ok {
			if u, lookupErr := user.LookupId(fmt.Sprintf("%d", st.Uid)); lookupErr == nil {
				return u.Username
			}
		}
	}
	return fallback
}

func ensureCronLog(logFile, home string) error {
	dir := filepath.Dir(logFile)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(logFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Chmod(logFile, 0o644); err != nil {
		return err
	}
	if os.Geteuid() == 0 {
		if info, err := os.Stat(home); err == nil {
			if st, ok := info.Sys().(*syscall.Stat_t); ok {
				_ = os.Chown(dir, int(st.Uid), int(st.Gid))
				_ = os.Chown(logFile, int(st.Uid), int(st.Gid))
			}
		}
	}
	return nil
}

func installUserContext() (string, string) {
	if sudoUser := strings.TrimSpace(os.Getenv("SUDO_USER")); sudoUser != "" && sudoUser != "root" {
		if u, err := user.Lookup(sudoUser); err == nil {
			return u.Username, u.HomeDir
		}
	}
	if u, err := user.Current(); err == nil {
		return u.Username, u.HomeDir
	}
	home, _ := os.UserHomeDir()
	return "", home
}

func buildCronLine(minute, hour int, bin, logFile string) string {
	cmd := fmt.Sprintf("%s %s cron run >> %s 2>&1", cronPATHEnv, shellEscape(bin), shellEscape(logFile))
	cmd = strings.ReplaceAll(cmd, "%", `\%`)
	return fmt.Sprintf("%d %d * * * %s %s", minute, hour, cmd, Marker)
}

func stripManaged(body string) []string {
	var out []string
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if !isManagedCrontabLine(line) {
			out = append(out, line)
		}
	}
	return out
}

func isManagedCrontabLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	for _, marker := range append([]string{Marker}, legacyMarkers...) {
		if strings.HasSuffix(trimmed, marker) {
			return true
		}
	}
	return false
}

// stripManagedBody removes only marker-owned cron lines and preserves every
// other byte, including comments, blank lines, and a missing final newline.
func stripManagedBody(body string) (string, bool) {
	var kept strings.Builder
	changed := false
	for len(body) > 0 {
		line := body
		body = ""
		if newline := strings.IndexByte(line, '\n'); newline >= 0 {
			body = line[newline+1:]
			line = line[:newline+1]
		}
		if isManagedCrontabLine(line) {
			changed = true
			continue
		}
		kept.WriteString(line)
	}
	return kept.String(), changed
}

// reconcileManagedUserCrontabs transactionally removes every cxx/cdx/clx
// marker from all discovered per-user crontabs. Discovery includes standard
// cron spool owners plus root/current/sudo/config-owner safeguards.
func reconcileManagedUserCrontabs() (userCrontabRollback, error) {
	users, err := discoverCrontabOwners()
	if err != nil {
		return nil, err
	}
	changes := make([]userCrontabChange, 0, len(users))
	for _, userName := range users {
		original, readErr := readUserCrontab(userName)
		if readErr != nil {
			rollbackErr := restoreUserCrontabs(changes)
			return nil, errors.Join(fmt.Errorf("read managed crontab for %s: %w", userName, readErr), rollbackErr)
		}
		updated, changed := stripManagedBody(original)
		if !changed {
			continue
		}
		// Include this user before writing: crontab implementations may replace
		// the spool file and still report a later failure.
		changes = append(changes, userCrontabChange{user: userName, original: original})
		if writeErr := writeUserCrontab(userName, updated); writeErr != nil {
			rollbackErr := restoreUserCrontabs(changes)
			return nil, errors.Join(fmt.Errorf("write managed crontab for %s: %w", userName, writeErr), rollbackErr)
		}
	}
	return func() error { return restoreUserCrontabs(changes) }, nil
}

func restoreUserCrontabs(changes []userCrontabChange) error {
	var errs []error
	for i := len(changes) - 1; i >= 0; i-- {
		change := changes[i]
		if err := writeUserCrontab(change.user, change.original); err != nil {
			errs = append(errs, fmt.Errorf("restore crontab for %s: %w", change.user, err))
		}
	}
	return errors.Join(errs...)
}

func discoverManagedCrontabOwners() ([]string, error) {
	seen := map[string]struct{}{}
	addValidated := func(candidate string, required bool) error {
		candidate = strings.TrimSpace(candidate)
		if !validCrontabOwnerName(candidate) {
			if required {
				return fmt.Errorf("invalid crontab owner %q", candidate)
			}
			return nil
		}
		u, err := lookupCrontabUser(candidate)
		if err != nil {
			if required {
				return fmt.Errorf("resolve crontab owner %q: %w", candidate, err)
			}
			return nil
		}
		name := strings.TrimSpace(u.Username)
		if name == "" || strings.ContainsAny(name, "/\x00\r\n") || strings.HasPrefix(name, "-") {
			return fmt.Errorf("resolved invalid crontab owner %q", name)
		}
		seen[name] = struct{}{}
		return nil
	}

	for _, dir := range userCrontabSpoolDirs {
		entries, err := listCrontabSpool(dir)
		if err != nil {
			return nil, fmt.Errorf("list crontab spool %s: %w", dir, err)
		}
		for _, entry := range entries {
			if validCrontabOwnerName(entry) {
				// Protected spool filenames are authoritative account identities.
				// Static CGO-free builds cannot resolve NSS/SSSD-only users through
				// os/user, but crontab -u and the system cron daemon can.
				seen[entry] = struct{}{}
			}
		}
	}

	identity, err := resolveCronIdentity()
	if err != nil {
		return nil, fmt.Errorf("resolve system cron owner: %w", err)
	}
	if err := addValidated(identity.userName, true); err != nil {
		return nil, err
	}
	if current, currentErr := currentCrontabUser(); currentErr == nil {
		if err := addValidated(current.Username, true); err != nil {
			return nil, err
		}
	}
	if sudoUser := strings.TrimSpace(os.Getenv("SUDO_USER")); sudoUser != "" && sudoUser != "root" {
		if err := addValidated(sudoUser, false); err != nil {
			return nil, err
		}
	}
	if err := addValidated("root", true); err != nil {
		return nil, err
	}

	users := make([]string, 0, len(seen))
	for userName := range seen {
		users = append(users, userName)
	}
	sort.Strings(users)
	return users, nil
}

func validCrontabOwnerName(candidate string) bool {
	return candidate != "" &&
		!strings.ContainsAny(candidate, " \t/\x00\r\n") &&
		!strings.HasPrefix(candidate, "-") &&
		!strings.HasPrefix(candidate, ".")
}

func listCrontabSpool(path string) ([]string, error) {
	entries, err := os.ReadDir(path)
	if err == nil {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			names = append(names, entry.Name())
		}
		return names, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if os.Geteuid() == 0 {
		return nil, err
	}
	// A sudo-backed system install cannot normally read protected cron spools
	// directly. Probe optional directories first, then list names only; every
	// candidate is validated through os/user before it reaches crontab -u.
	if out, testErr := runCronSudo("test", "-d", path); testErr != nil {
		if strings.TrimSpace(string(out)) == "" {
			return nil, nil
		}
		return nil, fmt.Errorf("privileged spool probe: %w: %s", testErr, strings.TrimSpace(string(out)))
	}
	out, err := runCronSudo("ls", "-1A", "--", path)
	if err != nil {
		return nil, fmt.Errorf("privileged spool list: %w: %s", err, strings.TrimSpace(string(out)))
	}
	var names []string
	for _, name := range strings.Split(string(out), "\n") {
		if name != "" {
			names = append(names, name)
		}
	}
	return names, nil
}

func stripUserManaged() error {
	cur, err := readCrontab()
	if err != nil {
		return err
	}
	body, changed := stripManagedBody(cur)
	if !changed {
		return nil
	}
	return writeCrontab(body)
}

func readCrontab() (string, error) {
	cmd := exec.Command("crontab", crontabArgs("-l")...)
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return "", nil
		}
		return "", err
	}
	return string(out), nil
}

func writeCrontab(body string) error {
	cmd := exec.Command("crontab", crontabArgs("-")...)
	cmd.Stdin = strings.NewReader(body)
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func readCrontabForUser(userName string) (string, error) {
	cmd := crontabCommandForUser(userName, "-l")
	out, err := cmd.CombinedOutput()
	if err == nil {
		return string(out), nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 && strings.Contains(strings.ToLower(string(out)), "no crontab for") {
		return "", nil
	}
	return "", fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
}

func writeCrontabForUser(userName, body string) error {
	cmd := crontabCommandForUser(userName, "-")
	cmd.Stdin = strings.NewReader(body)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func crontabCommandForUser(userName string, args ...string) *exec.Cmd {
	name, commandArgs := crontabCommandSpecFor(os.Geteuid(), userName, args...)
	cmd := exec.Command(name, commandArgs...)
	cmd.Env = setEnv(setEnv(os.Environ(), "LC_ALL", "C"), "LANG", "C")
	return cmd
}

func crontabCommandSpecFor(euid int, userName string, args ...string) (string, []string) {
	crontabArgs := append([]string{"-u", userName}, args...)
	if euid == 0 {
		return "crontab", crontabArgs
	}
	return "sudo", append([]string{"-n", "crontab"}, crontabArgs...)
}

// crontabArgs keeps user-crontab cleanup attached to the install user when
// cxx is invoked via sudo. Without -u, a direct-root install would write the
// shared /etc/cron.d entry but inspect root's crontab, leaving the caller's
// legacy cdx/clx entry active beside it.
func crontabArgs(args ...string) []string {
	return crontabArgsFor(os.Geteuid(), os.Getenv("SUDO_USER"), args...)
}

func crontabArgsFor(euid int, sudoUser string, args ...string) []string {
	sudoUser = strings.TrimSpace(sudoUser)
	if euid == 0 && sudoUser != "" && sudoUser != "root" {
		return append([]string{"-u", sudoUser}, args...)
	}
	return args
}

func removeLegacySystemSchedules() error {
	var errs []error
	for _, path := range legacySystemPaths {
		if err := removeSystemFile(path); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func removeSystemFile(path string) error {
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err := os.Remove(path); err == nil || errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if !passwordlessSudo() {
		return fmt.Errorf("remove %s: passwordless sudo unavailable", path)
	}
	out, err := runCronSudo("rm", "-f", path)
	if err != nil {
		return fmt.Errorf("remove %s: %w: %s", path, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func canWriteBinary(path string) bool {
	// Self-update replaces by same-directory rename; access checks avoid opening
	// the currently executing inode O_WRONLY (Linux returns ETXTBSY for that).
	return unix.Access(path, unix.W_OK) == nil && unix.Access(filepath.Dir(path), unix.W_OK) == nil
}

func passwordlessSudo() bool {
	if _, err := exec.LookPath("sudo"); err != nil {
		return false
	}
	return exec.Command("sudo", "-n", "true").Run() == nil
}

var runCronSudo = func(args ...string) ([]byte, error) {
	return exec.Command("sudo", append([]string{"-n"}, args...)...).CombinedOutput()
}

func writeManagedFileAtomic(path string, body []byte, privileged bool) error {
	if info, err := os.Lstat(path); err == nil && info.IsDir() {
		return fmt.Errorf("managed cron path %s is a directory", path)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if !privileged {
		f, err := os.CreateTemp(filepath.Dir(path), ".cxx-managed-cron-*.new")
		if err != nil {
			return err
		}
		tmp := f.Name()
		defer os.Remove(tmp)
		if err := f.Chmod(0o644); err != nil {
			_ = f.Close()
			return err
		}
		if _, err := f.Write(body); err != nil {
			_ = f.Close()
			return err
		}
		if err := f.Sync(); err != nil {
			_ = f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		return os.Rename(tmp, path)
	}
	local, err := os.CreateTemp("", "cxx-managed-cron-*.new")
	if err != nil {
		return err
	}
	localPath := local.Name()
	defer os.Remove(localPath)
	if _, err := local.Write(body); err != nil {
		_ = local.Close()
		return err
	}
	if err := local.Close(); err != nil {
		return err
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	stage := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".new-"+hex.EncodeToString(nonce[:]))
	out, err := runCronSudo("install", "-m", "0644", localPath, stage)
	if err != nil {
		return fmt.Errorf("stage %s: %w: %s", path, err, strings.TrimSpace(string(out)))
	}
	defer runCronSudo("rm", "-f", stage)
	mvArgs := []string{"mv", "-f"}
	if runtime.GOOS == "linux" {
		mvArgs = append(mvArgs, "-T")
	}
	mvArgs = append(mvArgs, stage, path)
	out, err = runCronSudo(mvArgs...)
	if err != nil {
		return fmt.Errorf("atomically replace %s: %w: %s", path, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func shellEscape(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func deterministicTime(host string) (int, int) {
	if host == "" {
		host = "unknown"
	}
	var sum uint32
	for _, b := range []byte(host) {
		sum = sum*33 + uint32(b)
	}
	return int(sum % 60), int((sum / 60) % 4)
}

func setEnv(env []string, key, value string) []string {
	prefix := key + "="
	for i, item := range env {
		if strings.HasPrefix(item, prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}
