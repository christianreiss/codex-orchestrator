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

// Doctor runs the full diagnostic and writes a terminal-aware report.
// Returns nil if every row is OK/warn; returns an error if any row is fail.
func Doctor(ctx context.Context, cfg *config.Config, w io.Writer, wrapperVersion string) error {
	caps := ui.DetectCapsFor(w, themeFromConfig(cfg))
	report := ui.DoctorReport{
		Engine: "cdx",
		When:   time.Now(),
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
	report.Rows = append(report.Rows, checkCLI(ctx, cfg, wrapperVersion))

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
			Value: doctorFailureSummary(failures),
		}
	case worst == ui.ToneWarn:
		report.Result = ui.DoctorRow{Label: "Result", Tone: ui.ToneWarn, Value: "checks passed with warnings"}
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
	available := []string{}
	missing := []string{}
	tone := ui.ToneOK
	for _, dep := range []string{"curl"} {
		if _, err := exec.LookPath(dep); err != nil {
			missing = append(missing, dep)
			if tone != ui.ToneFail {
				tone = ui.ToneWarn
			}
			*hints = append(*hints, fmt.Sprintf("Install %s; some side-features need it.", dep))
		} else {
			available = append(available, dep)
		}
	}
	return ui.DoctorRow{Label: "Deps", Tone: tone, Value: dependencySummary(available, missing)}
}

func checkPaths() ui.DoctorRow {
	tone := ui.ToneOK
	parts := make([]string, 0, 2)
	if codexBin, err := FindCLI(); err != nil {
		tone = ui.ToneFail
		parts = append(parts, "codex unavailable: "+err.Error())
	} else {
		parts = append(parts, "codex="+codexBin)
	}
	if exe, err := os.Executable(); err != nil {
		tone = ui.ToneFail
		parts = append(parts, "wrapper unavailable: "+err.Error())
	} else {
		parts = append(parts, "wrapper="+exe)
	}
	return ui.DoctorRow{
		Label: "Paths",
		Tone:  tone,
		Value: strings.Join(parts, "; "),
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

func checkCLI(ctx context.Context, cfg *config.Config, runningWrapperVersion string) ui.DoctorRow {
	verCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	tone := ui.ToneOK
	codexDetail := ""
	if _, err := FindCLI(); err != nil {
		tone = ui.ToneFail
		codexDetail = "codex unavailable: " + err.Error()
	} else if codexVer := strings.TrimSpace(Version(verCtx)); codexVer == "" || strings.EqualFold(codexVer, "unknown") {
		tone = ui.ToneWarn
		codexDetail = "codex=unknown (version probe failed)"
	} else {
		codexDetail = "codex=" + codexVer
	}
	wrapperVer := strings.TrimSpace(runningWrapperVersion)
	if cfg != nil {
		wrapperVer = strDef(wrapperVer, cfg.Wrapper.Version)
	}
	if strings.TrimSpace(wrapperVer) == "" && tone == ui.ToneOK {
		tone = ui.ToneWarn
	}
	return ui.DoctorRow{
		Label: "CLI",
		Tone:  tone,
		Value: fmt.Sprintf("%s; wrapper=%s; %s/%s",
			codexDetail, strDef(wrapperVer, "unknown"),
			runtime.GOOS, runtime.GOARCH),
	}
}

func dependencySummary(available, missing []string) string {
	parts := make([]string, 0, 2)
	if len(available) > 0 {
		parts = append(parts, "available: "+strings.Join(available, ", "))
	}
	if len(missing) > 0 {
		parts = append(parts, "missing: "+strings.Join(missing, ", "))
	}
	return strings.Join(parts, "; ")
}

func doctorFailureSummary(failures int) string {
	if failures == 1 {
		return "1 check failed"
	}
	return fmt.Sprintf("%d checks failed", failures)
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
