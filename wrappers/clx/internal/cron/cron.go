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
	"path/filepath"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/update"
)

const marker = "# clx-managed-cron"

// WrapperVersion is the running wrapper's semantic version, set from main.go
// via ldflags.
var WrapperVersion = "dev"

// Install writes a fresh crontab line (replacing any existing managed entry)
// and pings /cron/check once so the server records an initial check-in.
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
	cur, _ := readCrontab()
	lines := stripManaged(cur)
	bin, err := os.Executable()
	if err != nil {
		return err
	}
	home, _ := os.UserHomeDir()
	logFile := filepath.Join(home, ".claude", "cron.log")
	host, _ := os.Hostname()
	min, hr := deterministicTime(host)
	entry := buildCronLine(min, hr, bin, logFile)
	lines = append(lines, entry)
	return writeCrontab(strings.Join(lines, "\n") + "\n")
}

// buildCronLine assembles the crontab entry with shell-escaped paths and
// `%` escaped to `\%`.
func buildCronLine(min, hr int, bin, logFile string) string {
	cronCommand := fmt.Sprintf("%s --cron run >> %s 2>&1", shellEscape(bin), shellEscape(logFile))
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
	tmp := dest + ".cron-new"
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
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	got, err := sha256File(tmp)
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if !strings.EqualFold(got, expectedSHA) {
		_ = os.Remove(tmp)
		return fmt.Errorf("sha256 mismatch (got %s, want %s)", got, expectedSHA)
	}
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("atomic swap: %w", err)
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
