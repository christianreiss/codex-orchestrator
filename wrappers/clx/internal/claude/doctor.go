package claude

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

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ui"
)

// Doctor runs the 14-row diagnostic for clx. Returns nil on no failures.
func Doctor(ctx context.Context, cfg *config.Config, w io.Writer) error {
	caps := ui.DetectCaps(themeFromConfig(cfg))
	report := ui.DoctorReport{
		WhenLine: fmt.Sprintf("clx %s  ·  Doctor report", time.Now().Format("2006-01-02 15:04")),
	}
	hints := []string{}
	failures := 0
	worst := ui.ToneOK

	bump := func(t ui.Tone) {
		switch t {
		case ui.ToneFail:
			failures++
			worst = ui.ToneFail
		case ui.ToneWarn:
			if worst != ui.ToneFail {
				worst = ui.ToneWarn
			}
		}
	}

	depRow := checkDeps(&hints)
	bump(depRow.Tone)
	report.Rows = append(report.Rows, depRow)

	report.Rows = append(report.Rows, checkPaths())

	authRow := checkAuth()
	bump(authRow.Tone)
	report.Rows = append(report.Rows, authRow)

	confRow := checkConfig()
	bump(confRow.Tone)
	report.Rows = append(report.Rows, confRow)

	mcpRow := checkMCP(&hints)
	bump(mcpRow.Tone)
	report.Rows = append(report.Rows, mcpRow)

	apiRow, latRow, syncTone, syncDetail := checkAPI(ctx, cfg)
	bump(apiRow.Tone)
	bump(latRow.Tone)
	report.Rows = append(report.Rows, ui.DoctorRow{Label: "Sync", Tone: syncTone, Value: syncDetail})
	report.Rows = append(report.Rows, apiRow)
	report.Rows = append(report.Rows, latRow)

	report.Rows = append(report.Rows, checkDisk())
	report.Rows = append(report.Rows, checkCron())
	report.Rows = append(report.Rows, checkSSHEnv())
	report.Rows = append(report.Rows, checkCLI(cfg))

	switch {
	case failures > 0:
		report.Result = ui.DoctorRow{Label: "Result", Tone: ui.ToneFail, Value: fmt.Sprintf("%d failure(s) — see hints ↓", failures)}
	case worst == ui.ToneWarn:
		report.Result = ui.DoctorRow{Label: "Result", Tone: ui.ToneWarn, Value: "passed with warnings"}
	default:
		report.Result = ui.DoctorRow{Label: "Result", Tone: ui.ToneOK, Value: "all checks passed"}
	}
	report.Hints = hints

	ui.PrintDoctor(w, caps, report)
	if failures > 0 {
		return errors.New("doctor checks failed")
	}
	return nil
}

func checkDeps(hints *[]string) ui.DoctorRow {
	parts := []string{}
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
			parts = append(parts, dep+" ⛔")
			tone = ui.ToneFail
			*hints = append(*hints, fmt.Sprintf("Install %s; Claude Code requires it.", dep))
		} else {
			parts = append(parts, dep+" ✅")
		}
	}
	return ui.DoctorRow{Label: "Deps", Tone: tone, Value: strings.Join(parts, " | ")}
}

func checkPaths() ui.DoctorRow {
	exe, _ := os.Executable()
	claudeBin, _ := FindCLI()
	return ui.DoctorRow{
		Label: "Paths",
		Tone:  ui.ToneOK,
		Value: fmt.Sprintf("claude=%s; wrapper=%s", claudeBin, exe),
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
	return ui.DoctorRow{Label: "Config", Tone: ui.ToneOK, Value: fmt.Sprintf("path=%s; %d bytes; updated %s", p, st.Size(), ui.DurationShort(time.Since(st.ModTime())))}
}

func checkMCP(hints *[]string) ui.DoctorRow {
	home, _ := os.UserHomeDir()
	p := filepath.Join(home, ".claude", "settings.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		return ui.DoctorRow{Label: "MCP", Tone: ui.ToneWarn, Value: "settings.json absent"}
	}
	s := string(raw)
	if strings.Contains(s, "\"mcpServers\"") && (strings.Contains(s, "\"clx\"") || strings.Contains(s, "\"codex-orchestrator\"")) {
		return ui.DoctorRow{Label: "MCP", Tone: ui.ToneOK, Value: "configured"}
	}
	*hints = append(*hints, "Add the clx MCP block to ~/.claude/settings.json (server-synced).")
	return ui.DoctorRow{Label: "MCP", Tone: ui.ToneWarn, Value: "no mcpServers.clx block"}
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
	out, err := exec.Command("crontab", "-l").Output()
	if err != nil {
		return ui.DoctorRow{Label: "Cron", Tone: ui.ToneWarn, Value: "no crontab"}
	}
	if strings.Contains(string(out), "# clx-managed-cron") {
		return ui.DoctorRow{Label: "Cron", Tone: ui.ToneOK, Value: "installed"}
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

func checkCLI(cfg *config.Config) ui.DoctorRow {
	cliVer := Version(context.Background())
	wrapperVer := ""
	if cfg != nil {
		wrapperVer = cfg.Wrapper.Version
	}
	return ui.DoctorRow{
		Label: "CLI",
		Tone:  ui.ToneOK,
		Value: fmt.Sprintf("claude=%s; wrapper=%s; %s/%s",
			strDef(cliVer, "—"), strDef(wrapperVer, "—"),
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
