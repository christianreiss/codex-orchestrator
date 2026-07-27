// Package cron manages the clx auto-update crontab entry. The marker line is
// `# clx-managed-cron` (legacy bash compatible). Install/Remove are crontab
// edits; Tick is the action run by `clx --cron run`.
package cron

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/peer"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ui"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/update"
)

const (
	marker      = "# clx-managed-cron"
	cronPATHEnv = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
)

// systemCronPath is the /etc/cron.d/ slot we own when the wrapper binary lives
// outside the invoking user's writable scope. Filename must contain no dots.
const systemCronPath = "/etc/cron.d/clx-managed"

// WrapperVersion is the running wrapper's semantic version, set from main.go
// via ldflags.
var WrapperVersion = "dev"

// Indirected for tests.
var (
	userCurrent = user.Current
	userLookup  = user.Lookup
)

// Install writes a fresh cron entry (replacing any existing managed entry)
// and pings /cron/check once so the server records an initial check-in. See
// the cdx-side Install for the privilege-mode logic — it's mirrored here.
// cfg may be nil — in which case the ping is skipped (used by tests).
func Install(cfg *config.Config) error {
	if err := installCrontab(); err != nil {
		return err
	}
	if cfg == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := pingCronCheck(ctx, cfg); err != nil {
		printPortableWarning("clx --cron install: initial /cron/check ping failed: " + err.Error())
	}
	return nil
}

func printPortableWarning(value string) {
	caps := ui.MinimalCaps(ui.DetectCaps(""))
	width := caps.Columns
	if width <= 0 {
		width = 80
	}
	fmt.Fprintln(os.Stderr, ui.TruncateText(ui.PlainInline(value), width, caps))
}

func installCrontab() error {
	bin, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(bin); err == nil {
		bin = resolved
	}

	host, _ := os.Hostname()
	min, hr := deterministicTime(host)

	if canWriteBinary(bin) {
		return installUserCron(bin, min, hr)
	}
	if !passwordlessSudo() {
		return fmt.Errorf(
			"clx binary at %s is not writable by %s and passwordless sudo is unavailable; "+
				"either grant the user passwordless sudo (so `clx --cron install` can drop %s) "+
				"or reinstall the wrapper into a user-writable BIN_DIR so per-user cron can swap it",
			bin, currentUserName(), systemCronPath,
		)
	}
	if err := installSystemCron(bin, min, hr); err != nil {
		return err
	}
	_ = stripUserCronManaged()
	return nil
}

func installUserCron(bin string, min, hr int) error {
	cur, err := readCrontab()
	if err != nil {
		return err
	}
	lines := stripManaged(cur)
	home, _ := os.UserHomeDir()
	logFile := filepath.Join(home, ".claude", "cron.log")
	entry := buildCronLine(min, hr, bin, logFile)
	lines = append(lines, entry)
	return writeCrontab(strings.Join(lines, "\n") + "\n")
}

// HOME pinned to /root for the same reason cdx does it — see the matching
// comment in cdx/internal/cron/cron.go. The upstream CLI scratchpad lives
// under $HOME/.claude/tmp/, and cron-as-root must not leak root-owned dirs
// into the install user's home.
//
// CDX_CONFIG_PATH is pinned for the same reason: every tick forces a guarded
// peer reconcile (peer.EnsureForCron) that may spawn `cdx --cron run` as a
// child of this root-owned process. Without it, cdx's own config.DefaultPath
// falls through to HOME=/root and resolves a phantom /root/.config/... file
// instead of this host's real one, so the Codex engine silently never
// updates via this tick even though the log reports success.
func installSystemCron(bin string, min, hr int) error {
	configPath, err := config.DefaultPath()
	if err != nil {
		return err
	}
	_, userHome := installUserContext()
	peerConfigPath := filepath.Join(userHome, ".config", "codex-orchestrator", "cdx.json")
	logFile := filepath.Join(userHome, ".claude", "cron.log")
	cmd := fmt.Sprintf("%s --cron run >> %s 2>&1", shellEscape(bin), shellEscape(logFile))
	cmd = strings.ReplaceAll(cmd, "%", `\%`)
	body := fmt.Sprintf(`# clx-managed — auto-update tick. Managed by `+"`clx --cron install`"+`; do not edit by hand.
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HOME=/root
CLX_CONFIG_PATH=%s
CDX_CONFIG_PATH=%s
%d %d * * * root %s
`, configPath, peerConfigPath, min, hr, cmd)
	if err := sudoWriteFile(systemCronPath, body, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", systemCronPath, err)
	}
	_ = os.MkdirAll(filepath.Dir(logFile), 0o755)
	if _, err := os.Stat(logFile); os.IsNotExist(err) {
		if f, ferr := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY, 0o644); ferr == nil {
			_ = f.Close()
		}
	}
	return nil
}

func installUserContext() (string, string) {
	if sudoUser := strings.TrimSpace(os.Getenv("SUDO_USER")); sudoUser != "" && sudoUser != "root" {
		if u, err := userLookup(sudoUser); err == nil && u != nil {
			return u.Username, u.HomeDir
		}
	}
	if u, err := userCurrent(); err == nil && u != nil {
		return u.Username, u.HomeDir
	}
	home, _ := os.UserHomeDir()
	return "", home
}

// buildCronLine assembles the crontab entry with shell-escaped paths and
// `%` escaped to `\%`.
func buildCronLine(min, hr int, bin, logFile string) string {
	cronCommand := fmt.Sprintf("%s %s --cron run >> %s 2>&1", cronPATHEnv, shellEscape(bin), shellEscape(logFile))
	cronCommand = strings.ReplaceAll(cronCommand, "%", `\%`)
	return fmt.Sprintf("%d %d * * * %s %s", min, hr, cronCommand, marker)
}

func shellEscape(s string) string {
	if s == "" {
		return "''"
	}
	if !needsQuoting(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func needsQuoting(s string) bool {
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '/', r == '.', r == '_', r == '-', r == '+', r == ':', r == '=':
		default:
			return true
		}
	}
	return false
}

func Remove() error {
	userErr := stripUserCronManaged()
	var sysErr error
	if _, err := os.Stat(systemCronPath); err == nil {
		if !passwordlessSudo() {
			sysErr = fmt.Errorf("%s exists but passwordless sudo is unavailable; remove it manually with `sudo rm %s`", systemCronPath, systemCronPath)
		} else if err := sudoRemoveFile(systemCronPath); err != nil {
			sysErr = fmt.Errorf("remove %s: %w", systemCronPath, err)
		}
	}
	return errors.Join(userErr, sysErr)
}

func stripUserCronManaged() error {
	cur, err := readCrontab()
	if err != nil {
		return err
	}
	lines := stripManaged(cur)
	body := strings.Join(lines, "\n")
	if body != "" {
		body += "\n"
	}
	return writeCrontab(body)
}

// realignSchedule is indirected so tests exercising Tick never touch the
// developer's real crontab.
var realignSchedule = realignManagedSchedule

// realignManagedSchedule rewrites the schedule fields of an already-installed
// managed entry when they no longer match the deterministic slot, leaving the
// command byte-identical. Without it the clx/cdx stagger (see
// slotOffsetMinutes) would only ever reach freshly minted hosts: Install runs
// from `clx --cron install` alone and a wrapper self-update never re-asserts
// the crontab, so every host installed before it would keep firing in the same
// minute as cdx forever.
//
// It deliberately never switches mechanism (user crontab vs /etc/cron.d) —
// that choice belongs to installCrontab, which makes it from the invoking
// user's write access to the binary. A system tick runs as root, for whom the
// binary IS writable, so healing via installCrontab would move the entry into
// root's personal crontab and leave the /etc/cron.d file in place: two entries
// where there was one.
func realignManagedSchedule() error {
	host, _ := os.Hostname()
	min, hr := deterministicTime(host)
	if _, err := os.Stat(systemCronPath); err == nil {
		return realignSystemCron(min, hr)
	}
	return realignUserCron(min, hr)
}

func realignSystemCron(min, hr int) error {
	raw, err := os.ReadFile(systemCronPath)
	if err != nil {
		return err
	}
	lines := strings.Split(string(raw), "\n")
	changed := false
	for i, line := range lines {
		next, ok := rescheduleLine(line, min, hr)
		if !ok {
			continue
		}
		lines[i] = next
		changed = true
	}
	if !changed {
		return nil
	}
	if !passwordlessSudo() {
		return fmt.Errorf(
			"%s fires in a stale slot but passwordless sudo is unavailable; re-run `clx --cron install` as a user who has it",
			systemCronPath,
		)
	}
	return sudoWriteFile(systemCronPath, strings.Join(lines, "\n"), 0o644)
}

func realignUserCron(min, hr int) error {
	cur, err := readCrontab()
	if err != nil {
		return err
	}
	lines := strings.Split(cur, "\n")
	changed := false
	for i, line := range lines {
		if !strings.Contains(line, marker) {
			continue
		}
		next, ok := rescheduleLine(line, min, hr)
		if !ok {
			continue
		}
		lines[i] = next
		changed = true
	}
	if !changed {
		return nil
	}
	body := strings.Join(lines, "\n")
	if !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	return writeCrontab(body)
}

// rescheduleLine swaps the leading minute and hour of a `M H * * *` entry and
// leaves the remainder — user field, command, quoting, escaped `%` — byte
// identical. It reports false when nothing needs changing, and refuses
// anything that is not a plain numeric daily slot: comments, `KEY=value` env
// lines and hand-written ranges/steps keep whatever an operator gave them.
func rescheduleLine(line string, min, hr int) (string, bool) {
	fields, rest, ok := splitCronSchedule(line)
	if !ok || rest == "" {
		return line, false
	}
	if !isCronNumber(fields[0]) || !isCronNumber(fields[1]) {
		return line, false
	}
	for _, field := range fields[2:] {
		if field != "*" {
			return line, false
		}
	}
	if fields[0] == strconv.Itoa(min) && fields[1] == strconv.Itoa(hr) {
		return line, false
	}
	return fmt.Sprintf("%d %d * * * %s", min, hr, rest), true
}

// splitCronSchedule peels off the five schedule fields and returns the rest of
// the line verbatim, so rewriting a schedule can never reflow a command whose
// quoted paths contain whitespace.
func splitCronSchedule(line string) (fields []string, rest string, ok bool) {
	i := 0
	for len(fields) < 5 {
		for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
			i++
		}
		start := i
		for i < len(line) && line[i] != ' ' && line[i] != '\t' {
			i++
		}
		if start == i {
			return nil, "", false
		}
		fields = append(fields, line[start:i])
	}
	for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
		i++
	}
	return fields, line[i:], true
}

func isCronNumber(field string) bool {
	if field == "" {
		return false
	}
	for _, r := range field {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// Result mirrors the cdx side: it lets cmdCron render a one-line summary of
// what a tick actually did. A no-op tick produces WrapperAction/CodexAction
// == "no_update".
type Result struct {
	WrapperVersion string
	WrapperAction  string
	WrapperTarget  string
	CodexVersion   string
	CodexBefore    string
	CodexAction    string
	CodexTarget    string
	Reported       bool
}

// Tick is the action taken by `clx --cron run`.
func Tick(ctx context.Context, cfg *config.Config) (Result, error) {
	return TickWithOptions(ctx, cfg, false)
}

// TickWithOptions is Tick with presentation state carried through unattended
// self/peer updates. Minimal mode stays portable even after a re-exec.
func TickWithOptions(ctx context.Context, cfg *config.Config, minimal bool) (Result, error) {
	logger := slog.Default()
	ensureCronPath()
	res := Result{
		WrapperVersion: WrapperVersion,
		WrapperAction:  "no_update",
		CodexAction:    "no_update",
	}
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
		Logger:        logger,
	})
	if err != nil {
		return res, err
	}

	claudeVer := strings.TrimSpace(claude.Version(ctx))
	res.CodexBefore = claudeVer
	res.CodexVersion = claudeVer
	check, err := client.CronCheck(ctx, orchestrator.CronCheckRequest{
		Engine:         "claude",
		ClientVersion:  claudeVer,
		WrapperVersion: WrapperVersion,
	})
	if err != nil {
		return res, fmt.Errorf("cron check: %w", err)
	}

	if check.Action == "disable" {
		logger.Info("cron: auto-update disabled by server; removing cron job")
		if err := Remove(); err != nil {
			logger.Warn("cron: failed to fully remove cron job", "err", err)
		}
		res.WrapperAction = "disable"
		res.CodexAction = "disable"
		return res, nil
	}

	if check.Wrapper != nil && check.Wrapper.Action == "update" {
		if os.Getenv("CLAUDE_WRAPPER_RESTARTED") == "1" {
			return res, fmt.Errorf("cron: wrapper update loop detected for target %s", check.Wrapper.TargetVersion)
		}
		if check.Wrapper.URL == "" || check.Wrapper.SHA256 == "" || check.Wrapper.TargetVersion == "" {
			return res, fmt.Errorf("cron: wrapper update requested but metadata incomplete (%+v)", check.Wrapper)
		}
		if !claude.SemverGT(check.Wrapper.TargetVersion, WrapperVersion) {
			logger.Warn("cron: skipping wrapper downgrade", "current", WrapperVersion, "target", check.Wrapper.TargetVersion)
		} else {
			downloadURL := resolveURL(cfg.Orchestrator.BaseURL, check.Wrapper.URL)
			exe, err := os.Executable()
			if err != nil {
				return res, fmt.Errorf("cron: resolve self path: %w", err)
			}
			if exe, err = filepath.EvalSymlinks(exe); err != nil {
				return res, fmt.Errorf("cron: eval self path: %w", err)
			}
			if err := downloadAndSwap(ctx, cfg, downloadURL, check.Wrapper.SHA256, exe); err != nil {
				return res, fmt.Errorf("cron: wrapper self-update: %w", err)
			}
			logger.Info("cron: wrapper updated; re-exec'ing", "target", check.Wrapper.TargetVersion)
			res.WrapperAction = "updated"
			res.WrapperTarget = check.Wrapper.TargetVersion
			reexecArgs := []string{"--cron", "run"}
			if minimal {
				reexecArgs = append(reexecArgs, "--minimal")
			}
			if err := update.ReExecAfterUpdate(exe, reexecArgs); err != nil {
				return res, fmt.Errorf("cron: re-exec after wrapper update: %w", err)
			}
			return res, nil
		}
	}

	targetClient := check.TargetVersion
	if targetClient == "" {
		targetClient = check.ClientVersion
	}
	if check.Action == "update" && targetClient != "" {
		logger.Info("cron: Claude update", "from", claudeVer, "to", targetClient, "enforce_exact", check.EnforceExact)
		res.CodexAction = "updated"
		res.CodexTarget = targetClient
		if err := claude.EnsureClaude(ctx, targetClient, check.EnforceExact, logger); err != nil {
			return res, fmt.Errorf("cron: claude update: %w", err)
		}
	}
	if err := claude.EnsureShellAliases(); err != nil {
		logger.Warn("cron: ensureShellAliases", "err", err)
	}

	// Keep the peer wrapper + engine current too: a dual-engine host must have
	// all four components (clx, cdx, claude, codex) updated by a single cron
	// entry. EnsureForCron no-ops when this tick was itself spawned by the
	// peer (CODEX_ORCH_PEER_SPAWN=1) or when the host has no peer engine.
	peer.EnsureForCron(ctx, cfg, minimal, logger)

	// Hosts installed before clx staggered away from cdx still hold the
	// colliding slot; nothing else ever rewrites it, so heal it here.
	if err := realignSchedule(); err != nil {
		logger.Warn("cron: schedule realign skipped", "err", err)
	}

	newVer := strings.TrimSpace(claude.Version(ctx))
	res.CodexVersion = newVer
	report := orchestrator.CronReportRequest{
		Engine:         "claude",
		ClientVersion:  newVer,
		WrapperVersion: WrapperVersion,
	}
	var reportErr error
	for attempt := 1; attempt <= 2; attempt++ {
		reportErr = client.CronReport(ctx, report)
		if reportErr == nil {
			res.Reported = true
			return res, nil
		}
		logger.Warn("cron: /cron/report attempt failed", "attempt", attempt, "err", reportErr)
		if attempt < 2 {
			select {
			case <-ctx.Done():
				return res, ctx.Err()
			case <-time.After(2 * time.Second):
			}
		}
	}
	return res, fmt.Errorf("cron: /cron/report failed after retry: %w", reportErr)
}

func ensureCronPath() {
	current := os.Getenv("PATH")
	if current == "" {
		_ = os.Setenv("PATH", strings.TrimPrefix(cronPATHEnv, "PATH="))
		return
	}
	parts := strings.Split(current, ":")
	have := make(map[string]struct{}, len(parts))
	for _, p := range parts {
		have[p] = struct{}{}
	}
	add := make([]string, 0, 2)
	for _, p := range []string{"/usr/local/sbin", "/usr/local/bin"} {
		if _, ok := have[p]; !ok {
			add = append(add, p)
		}
	}
	if len(add) == 0 {
		return
	}
	_ = os.Setenv("PATH", strings.Join(append(add, current), ":"))
}

func pingCronCheck(ctx context.Context, cfg *config.Config) error {
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err != nil {
		return err
	}
	claudeVer := strings.TrimSpace(claude.Version(ctx))
	_, err = client.CronCheck(ctx, orchestrator.CronCheckRequest{
		Engine:         "claude",
		ClientVersion:  claudeVer,
		WrapperVersion: WrapperVersion,
	})
	return err
}

func resolveURL(base, abs string) string {
	if strings.HasPrefix(abs, "http://") || strings.HasPrefix(abs, "https://") {
		return abs
	}
	base = strings.TrimRight(base, "/")
	if !strings.HasPrefix(abs, "/") {
		abs = "/" + abs
	}
	return base + abs
}

func downloadAndSwap(ctx context.Context, cfg *config.Config, url, expectedSHA, dest string) error {
	if len(expectedSHA) != 64 {
		return fmt.Errorf("invalid expected sha256 (len=%d)", len(expectedSHA))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if cfg.Orchestrator.APIKey != "" {
		req.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
	}
	req.Header.Set("User-Agent", "clx-cron-update/"+WrapperVersion)
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("download %s -> %d: %s", url, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	tmp, f, err := createWrapperTemp(dest)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	if _, err := io.Copy(f, resp.Body); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	got, err := sha256File(tmp)
	if err != nil {
		return err
	}
	if !strings.EqualFold(got, expectedSHA) {
		return fmt.Errorf("sha256 mismatch (got %s, want %s)", got, expectedSHA)
	}
	if err := installWrapperTemp(tmp, dest); err != nil {
		return err
	}
	return nil
}

func createWrapperTemp(dest string) (string, *os.File, error) {
	tmp := fmt.Sprintf("%s.cron-new.%d-%d", dest, os.Getpid(), time.Now().UnixNano())
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o755)
	if err == nil {
		return tmp, f, nil
	}
	f, err = os.CreateTemp("", filepath.Base(dest)+"-cron-*.new")
	if err != nil {
		return "", nil, err
	}
	if chmodErr := f.Chmod(0o755); chmodErr != nil {
		_ = f.Close()
		_ = os.Remove(f.Name())
		return "", nil, chmodErr
	}
	return f.Name(), f, nil
}

func installWrapperTemp(tmp, dest string) error {
	if err := os.Rename(tmp, dest); err == nil {
		return nil
	} else if _, sudoErr := exec.LookPath("sudo"); sudoErr != nil {
		return fmt.Errorf("atomic swap: %w", err)
	}
	cmd := exec.Command("sudo", "-n", "install", "-m", "0755", tmp, dest)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("atomic swap: sudo install failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func sha256File(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// slotOffsetMinutes staggers this entry against the cdx one. Both wrappers
// derive their slot from crc32(hostname) with identical arithmetic, so a
// dual-engine host used to schedule `cdx --cron run` and `clx --cron run` in
// the very same minute — and since each tick also reconciles the peer
// (peer.EnsureForCron spawns the other wrapper's tick), the host ran two full
// four-component update passes concurrently, racing each other's npm installs
// to apply the identical pending update. Half an hour keeps the slot
// deterministic while guaranteeing the two ticks never overlap. Only clx moves;
// cdx keeps the unsalted slot so existing Codex-only hosts are undisturbed.
const slotOffsetMinutes = 30

func deterministicTime(host string) (min, hr int) {
	if host == "" {
		host = "unknown"
	}
	sum := crc32.ChecksumIEEE([]byte(host))
	min = (int(sum%60) + slotOffsetMinutes) % 60
	hr = int((sum / 60) % 4)
	return
}

func readCrontab() (string, error) {
	cmd := exec.Command("crontab", "-l")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &bytes.Buffer{}
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return "", nil
		}
		return "", err
	}
	return out.String(), nil
}

func writeCrontab(body string) error {
	cmd := exec.Command("crontab", "-")
	cmd.Stdin = strings.NewReader(body)
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func stripManaged(s string) []string {
	out := []string{}
	for _, line := range strings.Split(s, "\n") {
		if strings.Contains(line, marker) {
			continue
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		out = append(out, line)
	}
	return out
}

// canWriteBinary / canWriteDir / passwordlessSudo / sudoWriteFile /
// sudoRemoveFile / currentUserName mirror the cdx implementations. Kept
// in-package so each wrapper stays self-contained for cross-builds.
func canWriteBinary(path string) bool {
	if !canWriteDir(filepath.Dir(path)) {
		return false
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err == nil {
		_ = f.Close()
		return true
	}
	if errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EROFS) {
		return false
	}
	return false
}

func canWriteDir(dir string) bool {
	if err := syscall.Access(dir, 2 /* W_OK */); err != nil {
		return false
	}
	return true
}

func passwordlessSudo() bool {
	if _, err := exec.LookPath("sudo"); err != nil {
		return false
	}
	cmd := exec.Command("sudo", "-n", "true")
	cmd.Stdin = nil
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	return cmd.Run() == nil
}

func sudoWriteFile(path, body string, mode os.FileMode) error {
	var stderr bytes.Buffer
	tee := exec.Command("sudo", "-n", "tee", path)
	tee.Stdin = strings.NewReader(body)
	tee.Stdout = io.Discard
	tee.Stderr = &stderr
	if err := tee.Run(); err != nil {
		return fmt.Errorf("sudo tee: %v (%s)", err, strings.TrimSpace(stderr.String()))
	}
	stderr.Reset()
	chmod := exec.Command("sudo", "-n", "chmod", fmt.Sprintf("%o", mode), path)
	chmod.Stderr = &stderr
	if err := chmod.Run(); err != nil {
		return fmt.Errorf("sudo chmod: %v (%s)", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func sudoRemoveFile(path string) error {
	var stderr bytes.Buffer
	cmd := exec.Command("sudo", "-n", "rm", "-f", path)
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("sudo rm: %v (%s)", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func currentUserName() string {
	if u, err := userCurrent(); err == nil && u != nil && u.Username != "" {
		return u.Username
	}
	if name := strings.TrimSpace(os.Getenv("USER")); name != "" {
		return name
	}
	return "?"
}
