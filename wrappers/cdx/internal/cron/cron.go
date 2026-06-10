// Package cron manages the cdx auto-update crontab entry. The legacy bash
// wrapper installed an entry like:
//
//	37 2 * * * /usr/local/bin/cdx --cron run >> ~/.codex/cron.log 2>&1 # cdx-managed-cron
//
// The minute (0-59) and hour (0-3) are derived deterministically from the
// hostname so all hosts don't hit the orchestrator at once.
//
// Tick is the action taken by `cdx --cron run`: it calls the server, applies
// any wrapper/Codex updates, then reports the new versions back. See
// api/src/routes/host/index.ts:118-209 for the server-side contract.
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

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/peer"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/update"
)

// Indirected for tests.
var (
	userCurrent = user.Current
	userLookup  = user.Lookup
)

const (
	marker      = "# cdx-managed-cron"
	cronPATHEnv = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
)

// WrapperVersion is the running wrapper's semantic version, set from main.go
// via ldflags. The cron Tick path sends it in CronCheck/CronReport so the
// server can decide whether a wrapper update is needed.
var WrapperVersion = "dev"

// systemCronPath is the /etc/cron.d/ slot we own when the wrapper binary lives
// outside the invoking user's writable scope (e.g. /usr/local/bin). Filename
// must contain no dots — cron skips entries that do.
const systemCronPath = "/etc/cron.d/cdx-managed"

// Install writes a fresh cron entry (replacing any existing managed entry)
// and pings /cron/check once so the server records an initial check-in.
//
// Install picks the entry's privilege based on whether the running user can
// rewrite the wrapper binary itself: if yes, a user crontab line is enough;
// if not, the only way the auto-update path can ever swap the binary is to
// run as root, so we drop a /etc/cron.d/cdx-managed file via passwordless
// sudo. Without passwordless sudo we refuse rather than install an entry
// that's guaranteed to fail every night.
//
// cfg may be nil — in which case the ping is skipped (used by tests).
func Install(cfg *config.Config) error {
	if err := installCrontab(); err != nil {
		return err
	}
	if cfg == nil {
		return nil
	}
	// Best-effort initial check-in. Failure is logged but does not fail Install
	// because the cron schedule itself is what actually matters going forward.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := pingCronCheck(ctx, cfg); err != nil {
		fmt.Fprintf(os.Stderr, "cdx --cron install: initial /cron/check ping failed: %v\n", err)
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

	// User can rewrite the binary → stick with the per-user crontab.
	if canWriteBinary(bin) {
		return installUserCron(bin, min, hr)
	}

	// Binary is system-owned. The auto-update can only swap it as root, so
	// install a system cron entry — but only if we can do so non-interactively.
	if !passwordlessSudo() {
		return fmt.Errorf(
			"cdx binary at %s is not writable by %s and passwordless sudo is unavailable; "+
				"either grant the user passwordless sudo (so `cdx --cron install` can drop %s) "+
				"or reinstall the wrapper into a user-writable BIN_DIR so per-user cron can swap it",
			bin, currentUserName(), systemCronPath,
		)
	}
	if err := installSystemCron(bin, min, hr); err != nil {
		return err
	}
	// Drop any stale per-user managed entry so we don't run both.
	_ = stripUserCronManaged()
	return nil
}

func installUserCron(bin string, min, hr int) error {
	cur, _ := readCrontab()
	lines := stripManaged(cur)
	home, _ := os.UserHomeDir()
	logFile := filepath.Join(home, ".codex", "cron.log")
	entry := buildCronLine(min, hr, bin, logFile)
	lines = append(lines, entry)
	return writeCrontab(strings.Join(lines, "\n") + "\n")
}

// installSystemCron writes /etc/cron.d/cdx-managed via passwordless sudo. The
// entry runs as root (so the wrapper can rewrite itself in /usr/local/bin) but
// is pinned to the installing user's config + log via env vars so cron-as-root
// reuses the same orchestrator credentials.
//
// HOME is deliberately pinned to /root, not the install user's home: the
// upstream codex CLI unpacks its argv[0] sandbox into `$HOME/.codex/tmp/arg0/`
// on every invocation (even `codex --version`). If the cron job's HOME points
// at the user's home, root's codex leaves root-owned scratch dirs under the
// user's ~/.codex/tmp/, which the user's next interactive `codex` then fails
// to clean (`Permission denied`). Keeping HOME=/root isolates that scratch
// space; CDX_CONFIG_PATH explicitly tells the wrapper where the user's
// orchestrator credentials live, so we don't need HOME for that anymore.
func installSystemCron(bin string, min, hr int) error {
	configPath := config.DefaultPath()
	_, userHome := installUserContext()
	logFile := filepath.Join(userHome, ".codex", "cron.log")
	cmd := fmt.Sprintf("%s --cron run >> %s 2>&1", shellEscape(bin), shellEscape(logFile))
	cmd = strings.ReplaceAll(cmd, "%", `\%`)
	body := fmt.Sprintf(`# cdx-managed — auto-update tick. Managed by `+"`cdx --cron install`"+`; do not edit by hand.
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HOME=/root
CDX_CONFIG_PATH=%s
%d %d * * * root %s
`, configPath, min, hr, cmd)
	if err := sudoWriteFile(systemCronPath, body, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", systemCronPath, err)
	}
	// Make sure the log file exists with the user's ownership so root appends
	// don't flip it to root-owned (which would lock the user out of `tail`).
	_ = os.MkdirAll(filepath.Dir(logFile), 0o755)
	if _, err := os.Stat(logFile); os.IsNotExist(err) {
		if f, ferr := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY, 0o644); ferr == nil {
			_ = f.Close()
		}
	}
	return nil
}

// installUserContext returns the user+home that the installed cron entry should
// run on behalf of. When `cdx --cron install` is invoked via sudo, this hops
// back to $SUDO_USER's home so root's empty ~/.config doesn't get baked in.
func installUserContext() (name, home string) {
	if sudoUser := strings.TrimSpace(os.Getenv("SUDO_USER")); sudoUser != "" && sudoUser != "root" {
		if u, err := userLookup(sudoUser); err == nil && u != nil {
			return u.Username, u.HomeDir
		}
	}
	if u, err := userCurrent(); err == nil && u != nil {
		return u.Username, u.HomeDir
	}
	home, _ = os.UserHomeDir()
	return "", home
}

// buildCronLine assembles the crontab entry with shell-escaped paths and
// `%` escaped to `\%` (cron treats `%` as a newline-into-stdin separator).
func buildCronLine(min, hr int, bin, logFile string) string {
	cronCommand := fmt.Sprintf("%s %s --cron run >> %s 2>&1", cronPATHEnv, shellEscape(bin), shellEscape(logFile))
	cronCommand = strings.ReplaceAll(cronCommand, "%", `\%`)
	return fmt.Sprintf("%d %d * * * %s %s", min, hr, cronCommand, marker)
}

// shellEscape returns a single-quoted, shell-safe form of s. Embedded single
// quotes are emitted as the four-character sequence (close-quote, backslash,
// escaped-quote, open-quote), matching the bash printf %q style used by the
// legacy wrapper for crontab path escaping.
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

// Remove drops any managed entry from both the user crontab and the system
// /etc/cron.d/cdx-managed slot. System removal goes through passwordless sudo
// when available; if sudo isn't available and the file exists, we surface a
// clear error so the operator knows manual cleanup is required.
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

// Result summarises what a Tick did so callers can render a human-readable
// status line. All fields are zero-safe — a no-op tick produces a Result with
// WrapperAction/CodexAction == "no_update" and no error.
type Result struct {
	WrapperVersion string // version before the tick
	WrapperAction  string // "no_update" | "updated" | "disable"
	WrapperTarget  string // target version if updated
	CodexVersion   string // version after the tick (post-update)
	CodexBefore    string // version before the tick
	CodexAction    string // "no_update" | "updated"
	CodexTarget    string // target version if updated
	Reported       bool   // /cron/report succeeded
}

// Tick is the action taken by `cdx --cron run`. It checks the orchestrator,
// applies any wrapper self-update (re-exec'ing into the new binary), then
// applies any Codex update, and finally reports the post-update versions
// back via /cron/report. A second /cron/report attempt is made on the first
// failure; persistent failure returns an error so callers can exit non-zero.
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

	codexVer := strings.TrimSpace(codex.Version(ctx))
	res.CodexBefore = codexVer
	res.CodexVersion = codexVer
	check, err := client.CronCheck(ctx, orchestrator.CronCheckRequest{
		Engine:         "codex",
		ClientVersion:  codexVer,
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

	// Wrapper self-update first: if the server wants us on a newer wrapper,
	// download/verify/swap/re-exec before touching the Codex CLI. The re-exec
	// guarantees the second pass runs with the freshly installed code.
	if check.Wrapper != nil && check.Wrapper.Action == "update" {
		if os.Getenv("CODEX_WRAPPER_RESTARTED") == "1" {
			return res, fmt.Errorf("cron: wrapper update loop detected for target %s", check.Wrapper.TargetVersion)
		}
		if check.Wrapper.URL == "" || check.Wrapper.SHA256 == "" || check.Wrapper.TargetVersion == "" {
			return res, fmt.Errorf("cron: wrapper update requested but metadata incomplete (%+v)", check.Wrapper)
		}
		if !codex.SemverGT(check.Wrapper.TargetVersion, WrapperVersion) {
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
			if err := update.ReExecAfterUpdate(exe, []string{"--cron", "run"}); err != nil {
				return res, fmt.Errorf("cron: re-exec after wrapper update: %w", err)
			}
			// syscall.Exec replaces the process, so reaching this point means it
			// returned an error — treated as a hard failure above.
			return res, nil
		}
	}

	// Codex CLI install/update. Server signals via top-level `action=update` +
	// `target_version`. We honour both: if there's a target, ensure it; if the
	// top-level action is no_update we still pass-through Version() and let
	// EnsureCodex short-circuit when current matches.
	targetClient := check.TargetVersion
	if targetClient == "" {
		targetClient = check.ClientVersion
	}
	if check.Action == "update" && targetClient != "" {
		logger.Info("cron: Codex update", "from", codexVer, "to", targetClient, "enforce_exact", check.EnforceExact)
		res.CodexAction = "updated"
		res.CodexTarget = targetClient
		if err := codex.EnsureCodex(ctx, targetClient, check.EnforceExact, logger); err != nil {
			return res, fmt.Errorf("cron: codex update: %w", err)
		}
	}
	if err := codex.EnsureShellAliases(); err != nil {
		logger.Warn("cron: ensureShellAliases", "err", err)
	}

	// Keep the peer wrapper + engine current too: a dual-engine host must have
	// all four components (cdx, clx, codex, claude) updated by a single cron
	// entry. EnsureForCron no-ops when this tick was itself spawned by the
	// peer (CODEX_ORCH_PEER_SPAWN=1) or when the host has no peer engine.
	peer.EnsureForCron(ctx, cfg, logger)

	// Re-read codex version (it may have changed) for the report.
	newCodexVer := strings.TrimSpace(codex.Version(ctx))
	res.CodexVersion = newCodexVer

	report := orchestrator.CronReportRequest{
		Engine:         "codex",
		ClientVersion:  newCodexVer,
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

// pingCronCheck runs a single /cron/check from the Install path so the
// server records the host as cron-active right away rather than waiting for
// the first scheduled minute.
func pingCronCheck(ctx context.Context, cfg *config.Config) error {
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err != nil {
		return err
	}
	codexVer := strings.TrimSpace(codex.Version(ctx))
	_, err = client.CronCheck(ctx, orchestrator.CronCheckRequest{
		Engine:         "codex",
		ClientVersion:  codexVer,
		WrapperVersion: WrapperVersion,
	})
	return err
}

// resolveURL returns abs when it already has a scheme; otherwise it prefixes
// abs with the configured orchestrator base URL.
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

// downloadAndSwap fetches the new wrapper, verifies the SHA-256, and renames
// it over the running executable. Uses cfg's API key/insecure setting.
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
	req.Header.Set("User-Agent", "cdx-cron-update/"+WrapperVersion)
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
	hr = int((sum / 60) % 4) // 0..3
	return
}

func readCrontab() (string, error) {
	cmd := exec.Command("crontab", "-l")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &bytes.Buffer{}
	if err := cmd.Run(); err != nil {
		// Empty crontab is fine.
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

// canWriteBinary reports whether the caller can rewrite the wrapper binary at
// `path`. We try a real O_WRONLY|O_APPEND open so the answer matches what the
// auto-update path will actually attempt (which uses os.Rename over the file
// after writing a sibling tmp). EACCES/EPERM/EROFS all mean "no".
func canWriteBinary(path string) bool {
	// Fast path: the directory we'd rename through must be writable too.
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
	// Anything else (file missing, etc.) is unexpected — be conservative.
	return false
}

func canWriteDir(dir string) bool {
	if err := syscall.Access(dir, 2 /* W_OK */); err != nil {
		return false
	}
	return true
}

// passwordlessSudo reports whether `sudo -n true` exits cleanly, i.e. the
// invoking user can run sudo without being prompted for a password. We check
// both that sudo is on PATH and that `-n true` succeeds — anything else is
// treated as "no passwordless sudo" rather than "unknown" so Install can fail
// safe instead of guessing.
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

// sudoWriteFile writes `body` to `path` as root via `sudo -n tee`, then chmods
// the result. Non-interactive (`-n`); the caller must have already verified
// passwordless sudo. We capture stderr so the wrapped error includes sudo's
// own diagnostic when something goes wrong.
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
