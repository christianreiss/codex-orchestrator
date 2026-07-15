package claude

import (
	"context"
	"encoding/json"
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

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ui"
)

// Doctor runs the full diagnostic for clx. Returns nil on no failures.
// minimal forces the stable ASCII report even when w is a capable TTY.
func Doctor(ctx context.Context, cfg *config.Config, w io.Writer, wrapperVersion string, minimal bool) error {
	caps := doctorCaps(ui.DetectCapsFor(w, themeFromConfig(cfg)), minimal)
	report := ui.DoctorReport{
		Engine: "clx",
		When:   time.Now(),
	}
	hints := []string{}

	report.Rows = append(report.Rows, checkDeps(&hints))

	report.Rows = append(report.Rows, checkPaths())

	report.Rows = append(report.Rows, checkAuth())

	report.Rows = append(report.Rows, checkConfig())

	report.Rows = append(report.Rows, checkMCP(&hints))

	apiRow, latRow, syncTone, syncDetail := checkAPI(ctx, cfg)
	report.Rows = append(report.Rows, ui.DoctorRow{Label: "Sync", Tone: syncTone, Value: syncDetail})
	report.Rows = append(report.Rows, apiRow)
	report.Rows = append(report.Rows, latRow)

	report.Rows = append(report.Rows, checkDisk())
	report.Rows = append(report.Rows, checkCron())
	report.Rows = append(report.Rows, checkSSHEnv())
	report.Rows = append(report.Rows, checkCLI(ctx, cfg, wrapperVersion))

	// Result — tallied from EVERY appended row so no check is silently dropped
	// from the verdict. (Paths/Disk/Cron/SSH env/CLI were previously omitted
	// from the tally, so a red Disk row would still print "all checks passed"
	// and exit 0, contradicting this function's contract.)
	failures, worst := tallyRows(report.Rows)

	switch {
	case failures > 0:
		report.Result = ui.DoctorRow{Label: "Result", Tone: ui.ToneFail, Value: doctorFailureSummary(failures)}
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

func doctorCaps(caps ui.Caps, minimal bool) ui.Caps {
	if minimal {
		return ui.MinimalCaps(caps)
	}
	return caps
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
	required := []string{"curl", "node"}
	for _, dep := range required {
		bin := dep
		if dep == "node" {
			if _, err := exec.LookPath("node"); err != nil {
				if _, err2 := exec.LookPath("nodejs"); err2 == nil {
					bin = "nodejs"
				}
			}
		}
		if _, err := exec.LookPath(bin); err != nil {
			missing = append(missing, dep)
			tone = ui.ToneFail
			*hints = append(*hints, fmt.Sprintf("Install %s; Claude Code requires it.", dep))
		} else {
			available = append(available, dep)
		}
	}
	return ui.DoctorRow{Label: "Deps", Tone: tone, Value: dependencySummary(available, missing)}
}

func checkPaths() ui.DoctorRow {
	tone := ui.ToneOK
	parts := make([]string, 0, 2)
	if claudeBin, err := FindCLI(); err != nil {
		tone = ui.ToneFail
		parts = append(parts, "claude unavailable: "+err.Error())
	} else {
		parts = append(parts, "claude="+claudeBin)
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
	if !IsValidLocalAuth(p) {
		return ui.DoctorRow{Label: "Auth", Tone: ui.ToneFail, Value: "invalid credentials (no usable Claude token)"}
	}
	age := time.Since(st.ModTime())
	freshness, tone := "fresh", ui.ToneOK
	switch {
	case age > 7*24*time.Hour:
		freshness, tone = "stale", ui.ToneWarn
	case age > 24*time.Hour:
		freshness = "recent"
	}
	return ui.DoctorRow{Label: "Auth", Tone: tone, Value: fmt.Sprintf("%s (%s ago)", freshness, ui.DurationShort(age))}
}

func checkConfig() ui.DoctorRow {
	home, _ := os.UserHomeDir()
	p := filepath.Join(home, ".claude", "settings.json")
	st, err := os.Stat(p)
	if errors.Is(err, os.ErrNotExist) {
		return ui.DoctorRow{Label: "Config", Tone: ui.ToneWarn, Value: "no settings.json (will sync from server)"}
	}
	if err != nil {
		return ui.DoctorRow{Label: "Config", Tone: ui.ToneFail, Value: err.Error()}
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		return ui.DoctorRow{Label: "Config", Tone: ui.ToneFail, Value: err.Error()}
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil || doc == nil {
		return ui.DoctorRow{Label: "Config", Tone: ui.ToneFail, Value: "settings.json is not a valid JSON object"}
	}
	return ui.DoctorRow{Label: "Config", Tone: ui.ToneOK, Value: fmt.Sprintf("path=%s; %d bytes; updated %s", p, st.Size(), ui.DurationShort(time.Since(st.ModTime())))}
}

func checkMCP(hints *[]string) ui.DoctorRow {
	// Claude Code reads user-scope MCP servers from the TOP LEVEL of
	// ~/.claude.json — NOT from ~/.claude/settings.json. The wrapper syncs the
	// managed clx server there on every run (lifecycle/userconfig_merge.go).
	home, _ := os.UserHomeDir()
	p := filepath.Join(home, ".claude.json")
	raw, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return ui.DoctorRow{Label: "MCP", Tone: ui.ToneWarn, Value: ".claude.json absent"}
	}
	if err != nil {
		return ui.DoctorRow{Label: "MCP", Tone: ui.ToneFail, Value: err.Error()}
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil || doc == nil {
		return ui.DoctorRow{Label: "MCP", Tone: ui.ToneFail, Value: ".claude.json is not a valid JSON object"}
	}
	servers, _ := doc["mcpServers"].(map[string]any)
	managed, ok := servers["clx"].(map[string]any)
	if ok && len(managed) > 0 {
		return ui.DoctorRow{Label: "MCP", Tone: ui.ToneOK, Value: "configured"}
	}
	*hints = append(*hints, "Run clx once online to sync the clx MCP server into ~/.claude.json.")
	return ui.DoctorRow{Label: "MCP", Tone: ui.ToneWarn, Value: "no mcpServers.clx block"}
}

func checkAPI(ctx context.Context, cfg *config.Config) (ui.DoctorRow, ui.DoctorRow, ui.Tone, string) {
	apiTone := ui.ToneFail
	apiValue := "unreachable"
	latTone := ui.ToneFail
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
		if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
			apiTone = ui.ToneOK
			apiValue = fmt.Sprintf("reachable (http %d)", resp.StatusCode)
		} else {
			apiValue = fmt.Sprintf("unhealthy response (http %d)", resp.StatusCode)
		}
		latTone = ui.ToneOK
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

	digest, _ := LocalDigest()
	if ar, err := client.AuthRetrieve(ctx, digest); err == nil {
		syncDetail = fmt.Sprintf("auth=%s", ar.Status)
		switch strings.ToLower(ar.Status) {
		case "valid", "current", "ok":
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
	dir := filepath.Join(home, ".claude")
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

func checkCron() ui.DoctorRow {
	if _, err := os.Stat("/etc/cron.d/clx-managed"); err == nil {
		return ui.DoctorRow{Label: "Cron", Tone: ui.ToneOK, Value: "installed (system /etc/cron.d/clx-managed)"}
	}
	out, err := exec.Command("crontab", "-l").Output()
	if err != nil {
		return ui.DoctorRow{Label: "Cron", Tone: ui.ToneWarn, Value: "no crontab"}
	}
	if strings.Contains(string(out), "# clx-managed-cron") {
		return ui.DoctorRow{Label: "Cron", Tone: ui.ToneOK, Value: "installed (user crontab)"}
	}
	return ui.DoctorRow{Label: "Cron", Tone: ui.ToneWarn, Value: "not installed (run `clx --cron install`)"}
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
	claudeDetail := ""
	if _, err := FindCLI(); err != nil {
		tone = ui.ToneFail
		claudeDetail = "claude unavailable: " + err.Error()
	} else if cliVer := strings.TrimSpace(Version(verCtx)); cliVer == "" || strings.EqualFold(cliVer, "unknown") {
		tone = ui.ToneWarn
		claudeDetail = "claude=unknown (version probe failed)"
	} else {
		claudeDetail = "claude=" + cliVer
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
			claudeDetail, strDef(wrapperVer, "unknown"),
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
