package codex

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ui"
)

// Doctor runs the full 14-row diagnostic and writes the legacy-style table.
// Returns nil if every row is OK/warn; returns an error if any row is fail.
func Doctor(ctx context.Context, cfg *config.Config, w io.Writer, wrapperVersion string) error {
	caps := ui.DetectCaps(themeFromConfig(cfg))
	report := ui.DoctorReport{
		WhenLine: fmt.Sprintf("cdx %s  ·  Doctor report", time.Now().Format("2006-01-02 15:04")),
	}
	hints := []string{}

	// Deps
	report.Rows = append(report.Rows, checkDeps(&hints))

	// Paths
	report.Rows = append(report.Rows, checkPaths())

	// Auth
	report.Rows = append(report.Rows, checkAuth())

	// Config
	report.Rows = append(report.Rows, checkConfig())

	// MCP
	report.Rows = append(report.Rows, checkMCP(&hints))

	// API + Latency
	apiRow, latRow, syncTone, syncDetail := checkAPI(ctx, cfg)
	report.Rows = append(report.Rows, ui.DoctorRow{Label: "Sync", Tone: syncTone, Value: syncDetail})
	report.Rows = append(report.Rows, apiRow)
	report.Rows = append(report.Rows, latRow)

	// Disk
	report.Rows = append(report.Rows, checkDisk())

	// Cron
	report.Rows = append(report.Rows, checkCron(cfg))

	// SSH env
	report.Rows = append(report.Rows, checkSSHEnv())

	// CLI
	report.Rows = append(report.Rows, checkCLI(cfg, wrapperVersion))

	// Result — tallied from EVERY appended row so no check is silently dropped
	// from the verdict. (Sync/Disk/Cron/Paths were previously omitted from the
	// tally, so a red Disk row would still print "all checks passed" and exit 0,
	// contradicting this function's contract.)
	failures, worst := tallyRows(report.Rows)

	switch {
	case failures > 0:
		report.Result = ui.DoctorRow{
			Label: "Result",
			Tone:  ui.ToneFail,
			Value: fmt.Sprintf("%d failure(s) — see hints ↓", failures),
		}
	case worst == ui.ToneWarn:
		report.Result = ui.DoctorRow{Label: "Result", Tone: ui.ToneWarn, Value: "passed with warnings"}
	default:
		report.Result = ui.DoctorRow{Label: "Result", Tone: ui.ToneOK, Value: "all checks passed"}
	}
	report.Hints = hints

	ui.PrintDoctor(w, caps, report)
	if failures > 0 {
		return fmt.Errorf("%d doctor checks failed", failures)
	}
	return nil
}

// tallyRows reduces a set of report rows to (failure count, worst tone). It is
// the single source of truth for the doctor verdict so that every row a check
// appends is counted — adding a new row can never again be forgotten in a
// separate per-row bump call.
func tallyRows(rows []ui.DoctorRow) (failures int, worst ui.Tone) {
	worst = ui.ToneOK
	for _, row := range rows {
		switch row.Tone {
		case ui.ToneFail:
			failures++
			worst = ui.ToneFail
		case ui.ToneWarn:
			if worst != ui.ToneFail {
				worst = ui.ToneWarn
			}
		}
	}
	return failures, worst
}

func checkDeps(hints *[]string) ui.DoctorRow {
	parts := []string{}
	tone := ui.ToneOK
	for _, dep := range []string{"curl"} {
		if _, err := exec.LookPath(dep); err != nil {
			parts = append(parts, dep+" ⚠")
			if tone != ui.ToneFail {
				tone = ui.ToneWarn
			}
			*hints = append(*hints, fmt.Sprintf("Install %s; some side-features need it.", dep))
		} else {
			parts = append(parts, dep+" ✅")
		}
	}
	return ui.DoctorRow{Label: "Deps", Tone: tone, Value: strings.Join(parts, " | ")}
}

func checkPaths() ui.DoctorRow {
	exe, _ := os.Executable()
	codexBin, _ := FindCLI()
	return ui.DoctorRow{
		Label: "Paths",
		Tone:  ui.ToneOK,
		Value: fmt.Sprintf("codex=%s; wrapper=%s", codexBin, exe),
	}
}

func checkAuth() ui.DoctorRow {
	p, err := AuthPath()
	if err != nil {
		return ui.DoctorRow{Label: "Auth", Tone: ui.ToneFail, Value: err.Error()}
	}
	st, err := os.Stat(p)
	if errors.Is(err, os.ErrNotExist) {
		return ui.DoctorRow{Label: "Auth", Tone: ui.ToneWarn, Value: "missing (will sync on next run)"}
	}
	if err != nil {
		return ui.DoctorRow{Label: "Auth", Tone: ui.ToneFail, Value: err.Error()}
	}
	age := time.Since(st.ModTime())
	freshness := "fresh"
	tone := ui.ToneOK
	switch {
	case age > 7*24*time.Hour:
		freshness = "stale"
		tone = ui.ToneWarn
	case age > 24*time.Hour:
		freshness = "recent"
	}
	return ui.DoctorRow{Label: "Auth", Tone: tone, Value: fmt.Sprintf("%s (%s ago)", freshness, ui.DurationShort(age))}
}

func checkConfig() ui.DoctorRow {
	home, _ := os.UserHomeDir()
	cfg := filepath.Join(home, ".codex", "config.toml")
	st, err := os.Stat(cfg)
	if errors.Is(err, os.ErrNotExist) {
		return ui.DoctorRow{Label: "Config", Tone: ui.ToneWarn, Value: "no config.toml (will sync from server)"}
	}
	if err != nil {
		return ui.DoctorRow{Label: "Config", Tone: ui.ToneFail, Value: err.Error()}
	}
	return ui.DoctorRow{Label: "Config", Tone: ui.ToneOK,
		Value: fmt.Sprintf("path=%s; %d bytes; updated %s", cfg, st.Size(), ui.DurationShort(time.Since(st.ModTime())))}
}

func checkMCP(hints *[]string) ui.DoctorRow {
	home, _ := os.UserHomeDir()
	cfg := filepath.Join(home, ".codex", "config.toml")
	raw, err := os.ReadFile(cfg)
	if err != nil {
		return ui.DoctorRow{Label: "MCP", Tone: ui.ToneWarn, Value: "config.toml absent"}
	}
	if strings.Contains(string(raw), "[mcp_servers.cdx]") || strings.Contains(string(raw), "[mcp_servers.codex-orchestrator]") {
		if strings.Contains(string(raw), "enabled = false") {
			*hints = append(*hints, "MCP block is disabled (enabled = false). Remove that line to use orchestrator-provided MCP tools.")
			return ui.DoctorRow{Label: "MCP", Tone: ui.ToneWarn, Value: "configured but disabled"}
		}
		return ui.DoctorRow{Label: "MCP", Tone: ui.ToneOK, Value: "configured"}
	}
	return ui.DoctorRow{Label: "MCP", Tone: ui.ToneWarn, Value: "no [mcp_servers.cdx] section"}
}

func checkAPI(ctx context.Context, cfg *config.Config) (ui.DoctorRow, ui.DoctorRow, ui.Tone, string) {
	apiTone := ui.ToneFail
	apiValue := "unreachable"
	latTone := ui.ToneOK
	latValue := "-"
	syncTone := ui.ToneFail
	syncDetail := "no orchestrator response"

	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err != nil {
		return ui.DoctorRow{Label: "API", Tone: ui.ToneFail, Value: err.Error()},
			ui.DoctorRow{Label: "Latency", Tone: ui.ToneFail, Value: "-"},
			ui.ToneFail, err.Error()
	}

	t0 := time.Now()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, cfg.Orchestrator.BaseURL+"/versions", nil)
	resp, err := client.Do(ctx, req, 0)
	d := time.Since(t0)
	if err == nil {
		defer resp.Body.Close()
		apiTone = ui.ToneOK
		apiValue = fmt.Sprintf("reachable (http %d)", resp.StatusCode)
		latValue = d.Truncate(time.Millisecond).String()
		switch {
		case d > 5*time.Second:
			latTone = ui.ToneFail
		case d > 2*time.Second:
			latTone = ui.ToneWarn
		}
	} else {
		apiValue = err.Error()
	}

	// Auth-retrieve probe for sync digest match
	digest, _ := LocalDigest()
	if ar, err := client.AuthRetrieve(ctx, digest); err == nil {
		syncDetail = fmt.Sprintf("auth=%s", ar.Status)
		switch strings.ToLower(ar.Status) {
		case "valid", "current", "ok", "":
			syncTone = ui.ToneOK
		case "outdated", "updated", "missing", "upload_required":
			syncTone = ui.ToneWarn
		default:
			syncTone = ui.ToneFail
		}
	} else {
		syncDetail = "auth probe failed: " + err.Error()
	}

	return ui.DoctorRow{Label: "API", Tone: apiTone, Value: apiValue},
		ui.DoctorRow{Label: "Latency", Tone: latTone, Value: latValue},
		syncTone, syncDetail
}

func checkDisk() ui.DoctorRow {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".codex")
	_ = os.MkdirAll(dir, 0o700)
	var stat syscall.Statfs_t
	if err := syscall.Statfs(dir, &stat); err != nil {
		return ui.DoctorRow{Label: "Disk", Tone: ui.ToneWarn, Value: err.Error()}
	}
	freeMB := stat.Bavail * uint64(stat.Bsize) / (1024 * 1024)
	tone := ui.ToneOK
	switch {
	case freeMB < 500:
		tone = ui.ToneFail
	case freeMB < 1000:
		tone = ui.ToneWarn
	}
	return ui.DoctorRow{Label: "Disk", Tone: tone, Value: fmt.Sprintf("%dMB free", freeMB)}
}

func checkCron(cfg *config.Config) ui.DoctorRow {
	// System-mode install lives in /etc/cron.d/ and runs as root — that's the
	// preferred placement on hosts where the binary is system-owned, so look
	// for it before falling back to the per-user crontab.
	if _, err := os.Stat("/etc/cron.d/cdx-managed"); err == nil {
		return ui.DoctorRow{Label: "Cron", Tone: ui.ToneOK, Value: "installed (system /etc/cron.d/cdx-managed)"}
	}
	out, err := exec.Command("crontab", "-l").Output()
	if err != nil {
		return ui.DoctorRow{Label: "Cron", Tone: ui.ToneWarn, Value: "no crontab"}
	}
	if strings.Contains(string(out), "# cdx-managed-cron") {
		return ui.DoctorRow{Label: "Cron", Tone: ui.ToneOK, Value: "installed (user crontab)"}
	}
	return ui.DoctorRow{Label: "Cron", Tone: ui.ToneWarn, Value: "not installed (run `cdx --cron install`)"}
}

func checkSSHEnv() ui.DoctorRow {
	session := "local"
	if os.Getenv("SSH_TTY") != "" || os.Getenv("SSH_CONNECTION") != "" {
		session = "ssh"
	}
	parts := []string{"session=" + session, "TERM=" + os.Getenv("TERM")}
	if v := os.Getenv("TERM_PROGRAM"); v != "" {
		parts = append(parts, "TERM_PROGRAM="+v)
	}
	return ui.DoctorRow{Label: "SSH env", Tone: ui.ToneOK, Value: strings.Join(parts, "; ")}
}

func checkCLI(cfg *config.Config, runningWrapperVersion string) ui.DoctorRow {
	codexVer := Version(context.Background())
	wrapperVer := strings.TrimSpace(runningWrapperVersion)
	if cfg != nil {
		wrapperVer = strDef(wrapperVer, cfg.Wrapper.Version)
	}
	return ui.DoctorRow{
		Label: "CLI",
		Tone:  ui.ToneOK,
		Value: fmt.Sprintf("codex=%s; wrapper=%s; %s/%s",
			strDef(codexVer, "—"), strDef(wrapperVer, "—"),
			runtime.GOOS, runtime.GOARCH),
	}
}

func strDef(s, d string) string {
	if strings.TrimSpace(s) == "" {
		return d
	}
	return s
}

func themeFromConfig(cfg *config.Config) string {
	if cfg == nil || cfg.EngineOptions.AdminThemeHint == nil {
		return ""
	}
	return *cfg.EngineOptions.AdminThemeHint
}
