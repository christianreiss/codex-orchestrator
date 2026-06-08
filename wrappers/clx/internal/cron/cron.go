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
	"strings"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
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
		fmt.Fprintf(os.Stderr, "clx --cron install: initial /cron/check ping failed: %v\n", err)
	}
	return nil
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
	cur, _ := readCrontab()
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
func installSystemCron(bin string, min, hr int) error {
	configPath := config.DefaultPath()
	_, userHome := installUserContext()
	logFile := filepath.Join(userHome, ".claude", "cron.log")
	cmd := fmt.Sprintf("%s --cron run >> %s 2>&1", shellEscape(bin), shellEscape(logFile))
	cmd = strings.ReplaceAll(cmd, "%", `\%`)
	body := fmt.Sprintf(`# clx-managed — auto-update tick. Managed by `+"`clx --cron install`"+`; do not edit by hand.
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HOME=/root
CLX_CONFIG_PATH=%s
%d %d * * * root %s
`, configPath, min, hr, cmd)
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
	if err := stripUserCronManaged(); err != nil {
		return err
	}
	if _, err := os.Stat(systemCronPath); err == nil {
		if !passwordlessSudo() {
			return fmt.Errorf("%s exists but passwordless sudo is unavailable; remove it manually with `sudo rm %s`", systemCronPath, systemCronPath)
		}
		if err := sudoRemoveFile(systemCronPath); err != nil {
			return fmt.Errorf("remove %s: %w", systemCronPath, err)
		}
	}
	return nil
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
		_ = Remove()
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
		if err := update.ReExecAfterUpdate(exe, []string{"--cron", "run"}); err != nil {
			return res, fmt.Errorf("cron: re-exec after wrapper update: %w", err)
		}
		return res, nil
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
	tmp := dest + ".cron-new"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
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

func deterministicTime(host string) (min, hr int) {
	if host == "" {
		host = "unknown"
	}
	sum := crc32.ChecksumIEEE([]byte(host))
	min = int(sum % 60)
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
