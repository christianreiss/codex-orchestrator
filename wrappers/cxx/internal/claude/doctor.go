package claude

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/launcherdoctor"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/ui"
)

// Doctor runs the full diagnostic for clx. Returns nil on no failures.
// minimal forces the stable ASCII report even when w is a capable TTY.
func Doctor(ctx context.Context, cfg *config.Config, w io.Writer, wrapperVersion string, minimal bool) error {
	caps := launcherdoctor.Caps(ui.DetectCapsFor(w, launcherdoctor.Theme(cfg)), minimal)
	report := ui.DoctorReport{
		Engine: "clx",
		When:   time.Now(),
	}
	hints := []string{}

	// Node.js is not required: the managed install falls back to the native
	// CLI from the registry when npm is missing or broken.
	report.Rows = append(report.Rows, launcherdoctor.DepsRow(&hints, ui.ToneFail, "Install %s; Claude Code requires it."))

	report.Rows = append(report.Rows, checkPaths())
	report.Rows = append(report.Rows, launcherdoctor.LauncherRow(ctx, config.EngineClaude, &hints))

	report.Rows = append(report.Rows, checkAuth())

	report.Rows = append(report.Rows, checkConfig())

	report.Rows = append(report.Rows, checkPermissions(&hints))

	report.Rows = append(report.Rows, checkMCP(&hints))

	apiRow, latRow, syncTone, syncDetail := checkAPI(ctx, cfg)
	report.Rows = append(report.Rows, ui.DoctorRow{Label: "Sync", Tone: syncTone, Value: syncDetail})
	report.Rows = append(report.Rows, apiRow)
	report.Rows = append(report.Rows, latRow)

	// Engine: the fleet master switch. Only shown while it is off.
	if row, hint, suspended := engineSuspensionRow(cfg, syncDetail); suspended {
		report.Rows = append(report.Rows, row)
		hints = append(hints, hint)
	}

	home, _ := os.UserHomeDir()
	report.Rows = append(report.Rows, launcherdoctor.DiskRow(filepath.Join(home, ".claude")))
	report.Rows = append(report.Rows, launcherdoctor.CronRow("clx"))
	report.Rows = append(report.Rows, launcherdoctor.SSHEnvRow())
	report.Rows = append(report.Rows, checkCLI(ctx, cfg, wrapperVersion))

	return launcherdoctor.Finish(w, caps, report, hints)
}

var doctorEngine = launcherdoctor.Engine{CLI: "claude", FindCLI: FindCLI, Version: Version}

func checkPaths() ui.DoctorRow { return doctorEngine.PathsRow() }

func checkAuth() ui.DoctorRow {
	p, err := AuthPath()
	return launcherdoctor.AuthRow(p, err, IsValidLocalAuth, "invalid credentials (no usable Claude token)")
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

// checkPermissions reports whether this host can actually start in the permission
// mode it has been given.
//
// Claude Code refuses to launch when the resolved mode is `bypassPermissions` and
// the process is root, with no supported override. That combination does not make
// an agent permissive, it makes it unable to start -- and on the relay path the
// failure is silent, because the peer dies before it can report and its delivery
// goes terminally `ambiguous`, indistinguishable from a peer that declined.
//
// The orchestrator declines to serve that combination, so the FAIL row here means
// something went around it: a hand-edited file, or a host still pinned to an older
// orchestrator. The OK row exists so the substituted weaker mode is never a
// mystery to whoever set the posture.
func checkPermissions(hints *[]string) ui.DoctorRow {
	if os.Geteuid() != 0 {
		return ui.DoctorRow{Label: "Perms", Tone: ui.ToneOK, Value: "not root; permission mode unconstrained"}
	}
	mode, model := claudeSettingsPermissionMode()
	switch mode {
	case "":
		return ui.DoctorRow{Label: "Perms", Tone: ui.ToneOK, Value: "running as root; no permission mode pinned"}
	case "bypassPermissions":
		*hints = append(*hints,
			"claude refuses to start as root with permissions.defaultMode=bypassPermissions; "+
				"the fleet serves root hosts \"auto\" instead — run clx once to resync, or lower the host posture")
		return ui.DoctorRow{
			Label: "Perms",
			Tone:  ui.ToneFail,
			Value: "running as root with defaultMode=bypassPermissions; claude will refuse to start",
		}
	case "auto":
		if !modelLikelySupportsAutoMode(model) {
			*hints = append(*hints,
				"auto mode needs a recent model; on an older one the session falls back to prompting, "+
					"which an unattended run cannot answer")
			return ui.DoctorRow{
				Label: "Perms",
				Tone:  ui.ToneWarn,
				Value: fmt.Sprintf("root; defaultMode=auto but model %q may not support auto mode", model),
			}
		}
		return ui.DoctorRow{
			Label: "Perms",
			Tone:  ui.ToneOK,
			Value: "root; defaultMode=auto (bypassPermissions is not startable as root)",
		}
	default:
		return ui.DoctorRow{Label: "Perms", Tone: ui.ToneOK, Value: "root; defaultMode=" + mode}
	}
}

// claudeSettingsPermissionMode reads the mode and model out of the managed
// settings file. Unreadable or absent yields empty strings, which every caller
// treats as "nothing to report" rather than as a problem.
func claudeSettingsPermissionMode() (mode string, model string) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", ""
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return "", ""
	}
	var doc struct {
		Model       string `json:"model"`
		Permissions struct {
			DefaultMode string `json:"defaultMode"`
		} `json:"permissions"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", ""
	}
	return strings.TrimSpace(doc.Permissions.DefaultMode), strings.TrimSpace(doc.Model)
}

// modelLikelySupportsAutoMode screens out the families upstream names as
// unsupported -- Sonnet 4.5, Opus 4.5, Haiku 4.5 and claude-3. Haiku 5.5 (and the
// bare "haiku" alias, which resolves to it) supports auto mode, so Haiku is not
// screened by family; only its 4.5 and claude-3 generations match. It deliberately does
// not encode a version matrix: the supported set moves, and a wrapper that
// asserted it would drift into lying. An unknown model is treated as supported so
// this warns about what is known, never about what it merely fails to recognise.
func modelLikelySupportsAutoMode(model string) bool {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		return true
	}
	for _, unsupported := range []string{"claude-3", "-4-5", "4.5"} {
		if strings.Contains(m, unsupported) {
			return false
		}
	}
	return true
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
	apiRow, latRow := launcherdoctor.ProbeAPI(ctx, cfg.Orchestrator.BaseURL, client.Do)

	digest, _ := LocalDigest()
	ar, err := client.AuthRetrieve(ctx, digest)
	if err != nil {
		return apiRow, latRow, ui.ToneFail, "auth probe failed: " + err.Error()
	}
	return apiRow, latRow, launcherdoctor.SyncTone(ar.Status), fmt.Sprintf("auth=%s", ar.Status)
}

func checkCLI(ctx context.Context, cfg *config.Config, runningWrapperVersion string) ui.DoctorRow {
	return doctorEngine.CLIRow(ctx, cfg, runningWrapperVersion)
}

// engineSuspensionRow reports the fleet engine master switch.
func engineSuspensionRow(cfg *config.Config, syncDetail string) (ui.DoctorRow, string, bool) {
	return launcherdoctor.SuspensionRow(cfg, config.EngineClaude, orchestrator.AuthStatusSuspended, syncDetail)
}
