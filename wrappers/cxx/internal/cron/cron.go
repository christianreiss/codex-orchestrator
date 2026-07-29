// Package cron owns the single host-wide cxx maintenance schedule. Engine
// ticks remain engine-aware, but cdx/clx cron commands both enter this one
// coordinator so a dual-engine host has one schedule and one wrapper update.
package cron

import (
	"context"
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
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

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

var (
	fetchAuthoritative    = fleetconfig.Fetch
	persistAuthoritative  = fleetconfig.Persist
	removeEngineConfig    = fleetconfig.Remove
	runEngineTick         = defaultRunEngineTick
	installSystemSchedule = installSystemCron
	stripUserSchedule     = stripUserManaged
	removeLegacySchedules = removeLegacySystemSchedules
	removeSystemSchedule  = removeSystemFile
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
		var errs []error
		if err := stripUserManaged(); err != nil {
			errs = append(errs, err)
		}
		for _, path := range append([]string{systemCronPath}, legacySystemPaths...) {
			if err := removeSystemFile(path); err != nil {
				errs = append(errs, err)
			}
		}
		return errors.Join(errs...)
	})
}

// Run verifies every enabled signed config targets the same cxx bytes, then
// executes each persona tick once in a deterministic order. Child ticks are
// marked engine-only so alias forwarding cannot recurse.
func Run(ctx context.Context, seed *config.Config, minimal bool, stdout, stderr io.Writer) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	_, engines, canonical, err := refreshAuthoritative(ctx, seed, exe)
	if err != nil {
		return err
	}
	// A legacy cdx/clx schedule reaches this path first. Collapse both old
	// markers/files into the one cxx schedule before any child tick can recurse.
	if err := reconcileSchedule(ctx, canonical); err != nil {
		return fmt.Errorf("reconcile cxx cron schedule: %w", err)
	}
	runCtx, cancel := context.WithTimeout(ctx, coordinatorTimout)
	defer cancel()
	return runEnabledTicks(runCtx, canonical, engines, minimal, stdout, stderr)
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
	var errs []error
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
		errs = append(errs, loadErr)
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
	lines := stripManaged(cur)
	home, _ := os.UserHomeDir()
	logFile := filepath.Join(home, ".cxx", "cron.log")
	if err := os.MkdirAll(filepath.Dir(logFile), 0o700); err != nil {
		return err
	}
	lines = append(lines, buildCronLine(minute, hour, bin, logFile))
	return writeCrontab(strings.Join(lines, "\n") + "\n")
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
	cleanupErr := errors.Join(stripUserSchedule(), removeLegacySchedules())
	if cleanupErr == nil {
		return nil
	}
	// The new system entry must not survive beside an old user/persona entry.
	// Roll it back if cleanup could not prove exact-one scheduling.
	rollbackErr := removeSystemSchedule(systemCronPath)
	return errors.Join(cleanupErr, rollbackErr)
}

func installSystemCron(bin string, minute, hour int) error {
	privileged := os.Geteuid() != 0
	if privileged && !passwordlessSudo() {
		return fmt.Errorf("cxx at %s is not writable and passwordless sudo is unavailable", bin)
	}
	userName, home := installUserContext()
	cdxPath, clxPath, err := resolveCronConfigPaths(home)
	if err != nil {
		return err
	}
	home = inferConfigHome(home, cdxPath, clxPath)
	userName = inferHomeOwner(userName, home)
	logFile := filepath.Join(home, ".cxx", "cron.log")
	if err := ensureCronLog(logFile, home); err != nil {
		return fmt.Errorf("prepare cxx cron log: %w", err)
	}
	body := buildSystemCronBody(bin, cdxPath, clxPath, logFile, userName, home, minute, hour)
	return writeManagedFileAtomic(systemCronPath, []byte(body), privileged)
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
	markers := append([]string{Marker}, legacyMarkers...)
	var out []string
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		managed := false
		for _, marker := range markers {
			if strings.Contains(line, marker) {
				managed = true
				break
			}
		}
		if !managed {
			out = append(out, line)
		}
	}
	return out
}

func stripUserManaged() error {
	cur, err := readCrontab()
	if err != nil {
		return err
	}
	lines := stripManaged(cur)
	body := ""
	if len(lines) > 0 {
		body = strings.Join(lines, "\n") + "\n"
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
