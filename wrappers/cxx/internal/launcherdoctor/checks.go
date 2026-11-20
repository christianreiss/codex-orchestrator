package launcherdoctor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/installspace"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

// Engine names what the shared `cdx doctor` / `clx doctor` rows print for one
// engine. Engine-specific checks (config, MCP, permissions) stay with the
// engine.
type Engine struct {
	CLI     string // native command, e.g. "codex"
	FindCLI func() (string, error)
	Version func(context.Context) string
}

// Caps forces the stable ASCII report when --minimal is set.
func Caps(caps terminalui.Caps, minimal bool) terminalui.Caps {
	if minimal {
		return terminalui.MinimalCaps(caps)
	}
	return caps
}

// Theme returns the admin theme hint from the signed config.
func Theme(cfg *config.Config) string {
	if cfg == nil || cfg.EngineOptions.AdminThemeHint == nil {
		return ""
	}
	return *cfg.EngineOptions.AdminThemeHint
}

// Tally reduces a set of report rows to (failure count, worst tone). It is
// the single source of truth for the doctor verdict so that every row a check
// appends is counted — adding a new row can never again be forgotten in a
// separate per-row bump call.
func Tally(rows []terminalui.DoctorRow) (failures int, worst terminalui.Tone) {
	worst = terminalui.ToneOK
	for _, row := range rows {
		switch row.Tone {
		case terminalui.ToneFail:
			failures++
			worst = terminalui.ToneFail
		case terminalui.ToneWarn:
			if worst != terminalui.ToneFail {
				worst = terminalui.ToneWarn
			}
		}
	}
	return failures, worst
}

// Finish sets the verdict, tallied from EVERY appended row so no check is
// silently dropped, prints the report and returns an error if any row failed.
func Finish(w io.Writer, caps terminalui.Caps, report terminalui.DoctorReport, hints []string) error {
	failures, worst := Tally(report.Rows)
	switch {
	case failures > 0:
		report.Result = terminalui.DoctorRow{Label: "Result", Tone: terminalui.ToneFail, Value: failureSummary(failures)}
	case worst == terminalui.ToneWarn:
		report.Result = terminalui.DoctorRow{Label: "Result", Tone: terminalui.ToneWarn, Value: "checks passed with warnings"}
	default:
		report.Result = terminalui.DoctorRow{Label: "Result", Tone: terminalui.ToneOK, Value: "all checks passed"}
	}
	report.Hints = hints
	terminalui.PrintDoctor(w, caps, report)
	if failures > 0 {
		return fmt.Errorf("%d doctor checks failed", failures)
	}
	return nil
}

func failureSummary(failures int) string {
	if failures == 1 {
		return "1 check failed"
	}
	return fmt.Sprintf("%d checks failed", failures)
}

// LauncherRow is the PATH launcher row with its repair hint.
func LauncherRow(ctx context.Context, engine string, hints *[]string) terminalui.DoctorRow {
	exe, _ := os.Executable()
	row := Row(ctx, exe, []string{engine}, false)
	if row.Tone != terminalui.ToneOK {
		*hints = append(*hints, "Repair recognized legacy PATH launchers with `cxx doctor --fix`; this works without API access.")
	}
	return row
}

// DepsRow checks the host tools the wrapper shells out to. missingTone is the
// tone of a missing tool; hint is a format taking the tool name.
func DepsRow(hints *[]string, missingTone terminalui.Tone, hint string) terminalui.DoctorRow {
	available := []string{}
	missing := []string{}
	tone := terminalui.ToneOK
	for _, dep := range []string{"curl"} {
		if _, err := exec.LookPath(dep); err != nil {
			missing = append(missing, dep)
			if tone != terminalui.ToneFail {
				tone = missingTone
			}
			*hints = append(*hints, fmt.Sprintf(hint, dep))
		} else {
			available = append(available, dep)
		}
	}
	return terminalui.DoctorRow{Label: "Deps", Tone: tone, Value: DependencySummary(available, missing)}
}

func DependencySummary(available, missing []string) string {
	parts := make([]string, 0, 2)
	if len(available) > 0 {
		parts = append(parts, "available: "+strings.Join(available, ", "))
	}
	if len(missing) > 0 {
		parts = append(parts, "missing: "+strings.Join(missing, ", "))
	}
	return strings.Join(parts, "; ")
}

// PathsRow reports the native CLI and the running wrapper.
func (e Engine) PathsRow() terminalui.DoctorRow {
	tone := terminalui.ToneOK
	parts := make([]string, 0, 2)
	if bin, err := e.FindCLI(); err != nil {
		tone = terminalui.ToneFail
		parts = append(parts, e.CLI+" unavailable: "+err.Error())
	} else {
		parts = append(parts, e.CLI+"="+bin)
	}
	if exe, err := os.Executable(); err != nil {
		tone = terminalui.ToneFail
		parts = append(parts, "wrapper unavailable: "+err.Error())
	} else {
		parts = append(parts, "wrapper="+exe)
	}
	return terminalui.DoctorRow{
		Label: "Paths",
		Tone:  tone,
		Value: strings.Join(parts, "; "),
	}
}

// AuthRow reports the local credential file's presence, validity and age.
// invalid is the value printed when valid rejects the file.
func AuthRow(path string, pathErr error, valid func(string) bool, invalid string) terminalui.DoctorRow {
	if pathErr != nil {
		return terminalui.DoctorRow{Label: "Auth", Tone: terminalui.ToneFail, Value: pathErr.Error()}
	}
	st, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return terminalui.DoctorRow{Label: "Auth", Tone: terminalui.ToneWarn, Value: "missing (will sync on next run)"}
	}
	if err != nil {
		return terminalui.DoctorRow{Label: "Auth", Tone: terminalui.ToneFail, Value: err.Error()}
	}
	if !valid(path) {
		return terminalui.DoctorRow{Label: "Auth", Tone: terminalui.ToneFail, Value: invalid}
	}
	age := time.Since(st.ModTime())
	freshness, tone := "fresh", terminalui.ToneOK
	switch {
	case age > 7*24*time.Hour:
		freshness, tone = "stale", terminalui.ToneWarn
	case age > 24*time.Hour:
		freshness = "recent"
	}
	return terminalui.DoctorRow{Label: "Auth", Tone: tone, Value: fmt.Sprintf("%s (%s ago)", freshness, terminalui.DurationShort(age))}
}

// ProbeAPI times GET /versions through the engine's orchestrator client and
// returns the API and Latency rows.
func ProbeAPI(ctx context.Context, baseURL string, do func(context.Context, *http.Request, int) (*http.Response, error)) (api, latency terminalui.DoctorRow) {
	apiTone := terminalui.ToneFail
	apiValue := "unreachable"
	latTone := terminalui.ToneFail
	latValue := "-"

	t0 := time.Now()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/versions", nil)
	resp, err := do(ctx, req, 0)
	d := time.Since(t0)
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
			apiTone = terminalui.ToneOK
			apiValue = fmt.Sprintf("reachable (http %d)", resp.StatusCode)
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
			levels := communicator.ParseAPILevels(body)
			if note := communicator.APINote(levels); note != "" {
				apiValue += " · " + note
				if communicator.APIPolicy(communicator.APIVersion, levels) == communicator.APIStateUpdateRequired {
					apiTone = terminalui.ToneWarn
				}
			}
		} else {
			apiValue = fmt.Sprintf("unhealthy response (http %d)", resp.StatusCode)
		}
		latTone = terminalui.ToneOK
		latValue = d.Truncate(time.Millisecond).String()
		switch {
		case d > 5*time.Second:
			latTone = terminalui.ToneFail
		case d > 2*time.Second:
			latTone = terminalui.ToneWarn
		}
	} else {
		apiValue = err.Error()
	}
	return terminalui.DoctorRow{Label: "API", Tone: apiTone, Value: apiValue},
		terminalui.DoctorRow{Label: "Latency", Tone: latTone, Value: latValue}
}

// SyncTone grades an /auth retrieve status.
func SyncTone(status string) terminalui.Tone {
	switch strings.ToLower(status) {
	case "valid", "current", "ok":
		return terminalui.ToneOK
	case "outdated", "updated", "missing", "upload_required":
		return terminalui.ToneWarn
	default:
		return terminalui.ToneFail
	}
}

// DiskRow reports free space under dir, creating it first.
func DiskRow(dir string) terminalui.DoctorRow {
	_ = os.MkdirAll(dir, 0o700)
	capacity, err := installspace.Inspect(dir)
	if err != nil {
		return terminalui.DoctorRow{Label: "Disk", Tone: terminalui.ToneWarn, Value: err.Error()}
	}
	freeMB := capacity.Bytes / installspace.MiB
	tone := terminalui.ToneOK
	switch {
	case freeMB < 500:
		tone = terminalui.ToneFail
	case freeMB < 1000:
		tone = terminalui.ToneWarn
	}
	return terminalui.DoctorRow{Label: "Disk", Tone: tone, Value: fmt.Sprintf("%dMB free", freeMB)}
}

// CronRow reports the managed cron entry. command is the persona named in
// the install hint, e.g. "cdx".
func CronRow(command string) terminalui.DoctorRow {
	// System-mode install lives in /etc/cron.d/ and runs as root — that's the
	// preferred placement on hosts where the binary is system-owned, so look
	// for it before falling back to the per-user crontab.
	if _, err := os.Stat("/etc/cron.d/cxx-managed"); err == nil {
		return terminalui.DoctorRow{Label: "Cron", Tone: terminalui.ToneOK, Value: "installed (system /etc/cron.d/cxx-managed)"}
	}
	out, err := exec.Command("crontab", "-l").Output()
	if err != nil {
		return terminalui.DoctorRow{Label: "Cron", Tone: terminalui.ToneWarn, Value: "no crontab"}
	}
	if strings.Contains(string(out), "# cxx-managed-cron") {
		return terminalui.DoctorRow{Label: "Cron", Tone: terminalui.ToneOK, Value: "installed (user crontab)"}
	}
	return terminalui.DoctorRow{Label: "Cron", Tone: terminalui.ToneWarn, Value: "not installed (run `" + command + " cron install`)"}
}

func SSHEnvRow() terminalui.DoctorRow {
	session := "local"
	if os.Getenv("SSH_TTY") != "" || os.Getenv("SSH_CONNECTION") != "" {
		session = "ssh"
	}
	parts := []string{"session=" + session, "TERM=" + os.Getenv("TERM")}
	if v := os.Getenv("TERM_PROGRAM"); v != "" {
		parts = append(parts, "TERM_PROGRAM="+v)
	}
	return terminalui.DoctorRow{Label: "SSH env", Tone: terminalui.ToneOK, Value: strings.Join(parts, "; ")}
}

// CLIRow reports the native CLI version, the running wrapper version and the
// platform.
func (e Engine) CLIRow(ctx context.Context, cfg *config.Config, runningWrapperVersion string) terminalui.DoctorRow {
	verCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	tone := terminalui.ToneOK
	detail := ""
	if _, err := e.FindCLI(); err != nil {
		tone = terminalui.ToneFail
		detail = e.CLI + " unavailable: " + err.Error()
	} else if cliVer := strings.TrimSpace(e.Version(verCtx)); cliVer == "" || strings.EqualFold(cliVer, "unknown") {
		tone = terminalui.ToneWarn
		detail = e.CLI + "=unknown (version probe failed)"
	} else {
		detail = e.CLI + "=" + cliVer
	}
	wrapperVer := strings.TrimSpace(runningWrapperVersion)
	if cfg != nil {
		wrapperVer = strDef(wrapperVer, cfg.Wrapper.Version)
	}
	if strings.TrimSpace(wrapperVer) == "" && tone == terminalui.ToneOK {
		tone = terminalui.ToneWarn
	}
	return terminalui.DoctorRow{
		Label: "CLI",
		Tone:  tone,
		Value: fmt.Sprintf("%s; wrapper=%s; %s/%s",
			detail, strDef(wrapperVer, "unknown"),
			runtime.GOOS, runtime.GOARCH),
	}
}

func strDef(s, d string) string {
	if strings.TrimSpace(s) == "" {
		return d
	}
	return s
}

// SuspensionRow reports the fleet engine master switch: the server's live
// refusal when the auth probe was answered, otherwise the signed config. A
// positive answer means the engine is back on, so a stale config is ignored.
// suspendedStatus is the /auth status the server answers for a suspended
// engine.
func SuspensionRow(cfg *config.Config, engine, suspendedStatus, syncDetail string) (terminalui.DoctorRow, string, bool) {
	status, answered := strings.CutPrefix(syncDetail, "auth=")
	switch {
	case answered && strings.EqualFold(strings.TrimSpace(status), suspendedStatus):
	case !answered && cfg.EngineSuspended(engine):
	default:
		return terminalui.DoctorRow{}, "", false
	}
	hint := config.FleetDisabledMessage(engine) + " Launches and maintenance are paused until it is switched back on; nothing on this host needs repair."
	return terminalui.DoctorRow{Label: "Engine", Tone: terminalui.ToneFail, Value: "suspended (fleet)"}, hint, true
}
