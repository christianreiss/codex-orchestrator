package codex

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pelletier/go-toml"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/launcherdoctor"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/ui"
)

// Doctor runs the full diagnostic and writes a terminal-aware report.
// Returns nil if every row is OK/warn; returns an error if any row is fail.
// minimal forces the stable ASCII report even when w is a capable TTY.
func Doctor(ctx context.Context, cfg *config.Config, w io.Writer, wrapperVersion string, minimal bool) error {
	caps := launcherdoctor.Caps(ui.DetectCapsFor(w, launcherdoctor.Theme(cfg)), minimal)
	report := ui.DoctorReport{
		Engine: "cdx",
		When:   time.Now(),
	}
	hints := []string{}

	// Deps
	report.Rows = append(report.Rows, launcherdoctor.DepsRow(&hints, ui.ToneWarn, "Install %s; some side-features need it."))

	// Paths
	report.Rows = append(report.Rows, checkPaths())
	report.Rows = append(report.Rows, launcherdoctor.LauncherRow(ctx, config.EngineCodex, &hints))

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

	// Engine: the fleet master switch. Only shown while it is off.
	if row, hint, suspended := engineSuspensionRow(cfg, syncDetail); suspended {
		report.Rows = append(report.Rows, row)
		hints = append(hints, hint)
	}

	// Disk
	if dir, err := CodexHome(); err != nil {
		report.Rows = append(report.Rows, ui.DoctorRow{Label: "Disk", Tone: ui.ToneFail, Value: err.Error()})
	} else {
		report.Rows = append(report.Rows, launcherdoctor.DiskRow(dir))
	}

	// Cron
	report.Rows = append(report.Rows, launcherdoctor.CronRow("cdx"))

	// SSH env
	report.Rows = append(report.Rows, launcherdoctor.SSHEnvRow())

	// CLI
	report.Rows = append(report.Rows, checkCLI(ctx, cfg, wrapperVersion))

	return launcherdoctor.Finish(w, caps, report, hints)
}

var doctorEngine = launcherdoctor.Engine{CLI: "codex", FindCLI: FindCLI, Version: Version}

func checkPaths() ui.DoctorRow { return doctorEngine.PathsRow() }

func checkAuth() ui.DoctorRow {
	p, err := AuthPath()
	return launcherdoctor.AuthRow(p, err, IsValidLocalAuth, "invalid auth.json (no usable Codex token)")
}

func checkConfig() ui.DoctorRow {
	home, err := CodexHome()
	if err != nil {
		return ui.DoctorRow{Label: "Config", Tone: ui.ToneFail, Value: err.Error()}
	}
	cfg := filepath.Join(home, "config.toml")
	raw, err := os.ReadFile(cfg)
	if errors.Is(err, os.ErrNotExist) {
		return ui.DoctorRow{Label: "Config", Tone: ui.ToneWarn, Value: "no config.toml (will sync from server)"}
	}
	if err != nil {
		return ui.DoctorRow{Label: "Config", Tone: ui.ToneFail, Value: err.Error()}
	}
	if strings.TrimSpace(string(raw)) == "" {
		return ui.DoctorRow{Label: "Config", Tone: ui.ToneFail, Value: "config.toml is empty"}
	}
	if _, err := toml.LoadBytes(raw); err != nil {
		return ui.DoctorRow{Label: "Config", Tone: ui.ToneFail, Value: "invalid config.toml: " + err.Error()}
	}
	st, err := os.Stat(cfg)
	if err != nil {
		return ui.DoctorRow{Label: "Config", Tone: ui.ToneFail, Value: err.Error()}
	}
	return ui.DoctorRow{Label: "Config", Tone: ui.ToneOK,
		Value: fmt.Sprintf("path=%s; %d bytes; updated %s", cfg, st.Size(), ui.DurationShort(time.Since(st.ModTime())))}
}

func checkMCP(hints *[]string) ui.DoctorRow {
	home, homeErr := CodexHome()
	if homeErr != nil {
		return ui.DoctorRow{Label: "MCP", Tone: ui.ToneFail, Value: homeErr.Error()}
	}
	cfg := filepath.Join(home, "config.toml")
	raw, err := os.ReadFile(cfg)
	if err != nil {
		return ui.DoctorRow{Label: "MCP", Tone: ui.ToneWarn, Value: "config.toml absent"}
	}
	tree, err := toml.LoadBytes(raw)
	if err != nil {
		return ui.DoctorRow{Label: "MCP", Tone: ui.ToneFail, Value: "invalid config.toml: " + err.Error()}
	}
	for _, path := range [][]string{{"mcp_servers", "cdx"}, {"mcp_servers", "codex-orchestrator"}} {
		block, ok := tree.GetPath(path).(*toml.Tree)
		if !ok {
			continue
		}
		if enabled, ok := block.Get("enabled").(bool); ok && !enabled {
			*hints = append(*hints, "MCP block is disabled (enabled = false). Remove that line to use orchestrator-provided MCP tools.")
			return ui.DoctorRow{Label: "MCP", Tone: ui.ToneWarn, Value: "configured but disabled"}
		}
		return ui.DoctorRow{Label: "MCP", Tone: ui.ToneOK, Value: "configured"}
	}
	return ui.DoctorRow{Label: "MCP", Tone: ui.ToneWarn, Value: "no [mcp_servers.cdx] section"}
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

	// Auth-retrieve probe for sync digest match
	digest, _ := LocalDigest()
	ar, err := client.AuthRetrieve(ctx, digest)
	if err != nil {
		return apiRow, latRow, ui.ToneFail, "auth probe failed: " + err.Error()
	}
	var secure *bool
	if ar.Host != nil {
		value := ar.Host.Secure
		secure = &value
	}
	if securityErr := UpdateActiveAuthSessionSecurity(ar.Status, secure); securityErr != nil {
		return apiRow, latRow, ui.ToneFail, "auth session security update failed: " + securityErr.Error()
	}
	return apiRow, latRow, launcherdoctor.SyncTone(ar.Status), fmt.Sprintf("auth=%s", ar.Status)
}

func checkCLI(ctx context.Context, cfg *config.Config, runningWrapperVersion string) ui.DoctorRow {
	return doctorEngine.CLIRow(ctx, cfg, runningWrapperVersion)
}

// engineSuspensionRow reports the fleet engine master switch.
func engineSuspensionRow(cfg *config.Config, syncDetail string) (ui.DoctorRow, string, bool) {
	return launcherdoctor.SuspensionRow(cfg, config.EngineCodex, orchestrator.AuthStatusSuspended, syncDetail)
}
