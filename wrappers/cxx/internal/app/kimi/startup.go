package kimi

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/kimi"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/modelpolicy"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativeargs"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/quotaemulation"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
	"github.com/pelletier/go-toml"
)

// The runtime consumes Projection only. Presentation metadata never becomes
// part of the native credential file or an auth upload.
type startupAuth struct {
	QuotaSnapshot *quotaemulation.Snapshot `json:"quota_snapshot,omitempty"`
	native.Projection
	// PoolVerifiedAccounts counts accounts a launch could lease (metadata_only
	// answers only; older servers omit it). Status/verification describe one head.
	PoolVerifiedAccounts int64                        `json:"pool_verified_accounts"`
	APICalls             int64                        `json:"api_calls"`
	Versions             *orchestrator.VersionSummary `json:"versions"`
	Host                 *startupHost                 `json:"host"`
	KimiUsage            *kimiUsageReading            `json:"kimi_usage,omitempty"`
}

type kimiUsageReading struct {
	PlanName  *string           `json:"plan_name"`
	Windows   []kimiUsageWindow `json:"windows"`
	FetchedAt *string           `json:"fetched_at"`
	CheckedAt string            `json:"checked_at"`
	ErrorCode *string           `json:"error_code"`
}
type kimiUsageWindow struct {
	Kind        string   `json:"kind"`
	UsedPercent *float64 `json:"used_percent"`
	ResetsAt    *string  `json:"resets_at"`
}
type startupHost struct {
	FQDN        string   `json:"fqdn"`
	Secure      bool     `json:"secure"`
	APICalls    int64    `json:"api_calls"`
	Engines     string   `json:"engines"`
	EnginesList []string `json:"engines_list"`
	// FleetDisabledEngines is nil on servers that predate the fleet switch.
	FleetDisabledEngines []string `json:"fleet_disabled_engines"`
}

type resourceSync struct {
	Checked bool
	Updated bool
	// Failed marks a check that ran and could not complete; it warns.
	Failed bool
}

type managedSyncSummary struct {
	Skills, Config resourceSync
	Sessions       *orchestrator.FleetSessions
	Concurrent     bool
}

type startupInput struct {
	Config         *config.Config
	Auth           *startupAuth
	AuthErr        error
	EngineVersion  string
	VersionErr     error
	WrapperVersion string
	Home           string
	EffectiveHome  bool
	Overlay        native.ModelPreferences
	LaunchArgs     []string
	Sync           managedSyncSummary
	StatusOnly     bool
	Minimal        bool
}

func kimiQuotaRows(usage *kimiUsageReading, now time.Time) []terminalui.QuotaRow {
	var rows []terminalui.QuotaRow
	if usage == nil || usage.ErrorCode != nil {
		return rows
	}
	for _, w := range usage.Windows {
		if w.UsedPercent == nil || w.ResetsAt == nil {
			continue
		}
		used := *w.UsedPercent
		if math.IsNaN(used) || math.IsInf(used, 0) || used < 0 || used > 100 {
			continue
		}
		reset, err := time.Parse(time.RFC3339, *w.ResetsAt)
		if err != nil || !reset.After(now) {
			continue
		}
		label := map[string]string{"five_hour": "5h", "weekly": "weekly", "month_total": "month total", "month_code": "month code"}[w.Kind]
		if label == "" {
			continue
		}
		rows = append(rows, terminalui.QuotaRow{Label: label, Used: int(math.Round(used)), ResetAfter: reset.Sub(now)})
	}
	return rows
}
func kimiQuotaNote(usage *kimiUsageReading, now time.Time) string {
	if len(kimiQuotaRows(usage, now)) > 0 {
		return ""
	}
	return "Subscription quota usage is unavailable."
}
func startupScreen(in startupInput) terminalui.ScreenInput {
	ui := terminalui.ScreenInput{
		Prefix: "ckx", EngineName: "kimi", SkipBanner: in.Minimal,
		WrapperVersion: in.WrapperVersion, EngineVersion: in.EngineVersion,
		WrapperTone: terminalui.ToneOK, EngineTone: terminalui.ToneOK,
		QuotaNote:   kimiQuotaNote(nil, time.Now()),
		Concurrent:  in.Sync.Concurrent,
		ResultLabel: "Ready — subscription account leased.", ResultTone: terminalui.ToneOK,
	}
	if in.StatusOnly {
		ui.ResultLabel = "API and subscription auth checks passed."
	}
	if in.Config != nil {
		ui.HostFQDN, ui.Insecure = in.Config.Host.FQDN, !in.Config.Host.Secure
		if in.Config.EngineOptions.AdminThemeHint != nil {
			ui.Theme = *in.Config.EngineOptions.AdminThemeHint
		}
	}
	if in.Auth != nil {
		if rows := kimiQuotaRows(in.Auth.KimiUsage, time.Now()); len(rows) > 0 {
			ui.QuotaRows, ui.QuotaNote = rows, ""
		} else {
			ui.QuotaNote = kimiQuotaNote(in.Auth.KimiUsage, time.Now())
		}
		extraRows, emulationNotice := quotaemulation.Display(in.Auth.QuotaSnapshot, time.Now())
		ui.QuotaRows = append(ui.QuotaRows, extraRows...)
		if emulationNotice != "" {
			if ui.QuotaNote != "" {
				ui.QuotaNote += "; "
			}
			ui.QuotaNote += emulationNotice
		}
		if in.Auth.Host != nil {
			ui.APICalls = in.Auth.Host.APICalls
			ui.Insecure = !in.Auth.Host.Secure
			if in.Auth.Host.FQDN != "" {
				ui.HostFQDN = in.Auth.Host.FQDN
			}
		}
		if in.Auth.APICalls > 0 {
			ui.APICalls = in.Auth.APICalls
		}
		if v := in.Auth.Versions; v != nil {
			target := stringValue(v.ClientVersionOverride)
			if target == "" {
				target = stringValue(v.ClientVersion)
			}
			if target != "" && target != "latest" && target != in.EngineVersion &&
				(in.EngineVersion == "" || v.ClientVersionEnforceExact || codex.SemverGT(target, in.EngineVersion)) {
				ui.EngineTarget, ui.EngineTone = target, terminalui.ToneWarn
			}
			if target := stringValue(v.WrapperVersion); target != "" && target != in.WrapperVersion &&
				(in.WrapperVersion == "" || in.WrapperVersion == "dev" || in.WrapperVersion == "unknown" || codex.SemverGT(target, in.WrapperVersion)) {
				ui.WrapperTarget, ui.WrapperTone = target, terminalui.ToneWarn
			}
		}
	}
	if strings.TrimSpace(in.EngineVersion) == "" || in.VersionErr != nil {
		ui.EngineTone = terminalui.ToneFail
		ui.ResultLabel, ui.ResultTone = "Kimi missing or unavailable; run `ckx update`.", terminalui.ToneFail
	}
	if strings.TrimSpace(in.WrapperVersion) == "" || in.WrapperVersion == "dev" || in.WrapperVersion == "unknown" {
		ui.WrapperTone = terminalui.ToneWarn
	}

	apiTone, authTone := terminalui.ToneOK, terminalui.ToneOK
	// A typed HTTP error means the orchestrator answered: the API is healthy and
	// the failure belongs to auth (login required, insecure approval, ...).
	var httpErr *orchestrator.HTTPError
	answered := in.AuthErr != nil && errors.As(in.AuthErr, &httpErr)
	if !answered && (in.Auth == nil || in.AuthErr != nil || in.Auth.Status == "") {
		apiTone = terminalui.ToneFail
	}
	if !authUsable(in.Auth, in.AuthErr) {
		authTone = terminalui.ToneFail
		ui.ResultLabel, ui.ResultTone = "Subscription auth unavailable; run `ckx login`.", terminalui.ToneFail
		if status := orchestrator.InsecureStatusFromError(in.AuthErr); status == "insecure" {
			ui.ResultLabel = "Insecure host approval pending; open Admin → Host Detail."
		} else if status == "insecure-denied" {
			ui.ResultLabel = "Insecure host approval was denied."
		}
	}
	if in.VersionErr != nil {
		ui.ResultLabel = "Kimi missing or unavailable; run `ckx update`."
	}
	// The fleet master switch, host removal and the API kill switch outrank
	// every other verdict: none of them is fixed by `ckx login` or an update.
	if label := refusalLabel(in.Config, in.AuthErr); label != "" {
		authTone = terminalui.ToneFail
		ui.ResultLabel, ui.ResultTone = label, terminalui.ToneFail
	}
	ui.Dots = []terminalui.HealthDot{{Name: "api", Tone: apiTone}, {Name: "auth", Tone: authTone}}
	if !in.StatusOnly {
		ui.Dots = append(ui.Dots, resourceDot("skills", in.Sync.Skills), resourceDot("config", in.Sync.Config))
	}
	runnerTone := terminalui.ToneDim
	if in.Auth != nil && in.Auth.Versions != nil && in.Auth.Versions.RunnerState != nil {
		switch strings.ToLower(stringValue(in.Auth.Versions.RunnerState)) {
		case "ok", "fresh", "verified":
			runnerTone = terminalui.ToneOK
		default:
			runnerTone = terminalui.ToneWarn
		}
	}
	// A rendered MCP entry is configuration evidence, not a connectivity probe.
	ui.Dots = append(ui.Dots, terminalui.HealthDot{Name: "runner", Tone: runnerTone}, terminalui.HealthDot{Name: "mcp", Tone: terminalui.ToneDim})
	if runnerTone == terminalui.ToneWarn || ui.EngineTone == terminalui.ToneWarn || ui.WrapperTone == terminalui.ToneWarn {
		if ui.ResultTone != terminalui.ToneFail {
			ui.ResultLabel, ui.ResultTone = "Ready with warnings; run `ckx doctor` for details.", terminalui.ToneWarn
		}
	}
	if in.Sync.Concurrent {
		ui.ConcurrentNote = "Managed content sync paused; subscription auth freshness remains active."
		if ui.ResultTone == terminalui.ToneOK {
			ui.ResultLabel = ui.ConcurrentNote
		}
	}
	var prefsErr error
	ui.Model, ui.Effort, prefsErr = startupPreferences(in)
	if prefsErr != nil && ui.ResultTone != terminalui.ToneFail {
		ui.ResultLabel, ui.ResultTone = "Native settings could not be read; run `ckx doctor`.", terminalui.ToneWarn
		if !in.StatusOnly {
			for i := range ui.Dots {
				if ui.Dots[i].Name == "config" {
					ui.Dots[i].Tone, ui.Dots[i].Updated = terminalui.ToneWarn, false
				}
			}
		}
	}
	if s := in.Sync.Sessions; s != nil {
		ui.SessionRows = []terminalui.SessionRow{{Label: "hosts 30m", Count: s.Now}, {Label: "syncs UTC day", Count: s.Today}, {Label: "syncs UTC month", Count: s.Month}}
	}
	ui.BypassPermissions = nativeFlag(in.LaunchArgs, "--auto")
	return ui
}

// authUsable: "available" is the metadata_only answer status/doctor read (a
// stored, verified login); a launch replaces it with its leased grant first. A
// missing or unverified account-less head is still fine when a lease could pick
// another verified pool account.
func authUsable(auth *startupAuth, err error) bool {
	if auth == nil || err != nil {
		return false
	}
	if auth.VerificationState == "verified" && hasArg([]string{auth.Status}, "valid", "outdated", "updated", "ok", "unchanged", "available") {
		return true
	}
	return auth.PoolVerifiedAccounts > 0
}

func leasedStartupAuth(initial startupAuth, lease *accountpool.LeaseResponse) startupAuth {
	if lease != nil {
		initial.Projection = native.Projection{Status: "valid", Auth: lease.Auth, AccountID: lease.AccountID, VerificationState: lease.VerificationState, AccountPool: true}
		initial.QuotaSnapshot = lease.QuotaSnapshot
		if len(lease.KimiUsage) > 0 {
			var usage kimiUsageReading
			if json.Unmarshal(lease.KimiUsage, &usage) == nil {
				initial.KimiUsage = &usage
			}
		}
		// The concrete grant now decides; pool availability must not paper over
		// an unexpected unverified lease.
		initial.PoolVerifiedAccounts = 0
	}
	return initial
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func resourceDot(name string, state resourceSync) terminalui.HealthDot {
	tone := terminalui.ToneDim
	if state.Checked {
		tone = terminalui.ToneOK
	}
	if state.Failed {
		tone = terminalui.ToneWarn
	}
	return terminalui.HealthDot{Name: name, Tone: tone, Updated: state.Checked && state.Updated}
}

func startupPreferences(in startupInput) (string, string, error) {
	settings := map[string]any{}
	raw, err := os.ReadFile(filepath.Join(in.Home, "config.toml"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", "", err
	}
	if len(raw) > 0 {
		tree, err := toml.LoadBytes(raw)
		if err != nil {
			return "", "", err
		}
		settings = tree.ToMap()
	}
	model, _ := settings["default_model"].(string)
	thinking, _ := settings["thinking"].(map[string]any)
	effort, _ := thinking["effort"].(string)
	overlay := in.Overlay
	if !in.EffectiveHome {
		overlay = native.ProcessModelPreferences()
	}
	if overlay.Model != "" {
		model = overlay.Model
	}
	if overlay.Effort != "" {
		effort = overlay.Effort
	}
	if !in.EffectiveHome && in.Config != nil {
		if in.Config.EngineOptions.ModelOverride != nil {
			model = *in.Config.EngineOptions.ModelOverride
		}
		if in.Config.EngineOptions.KimiModelOverride != nil {
			model = *in.Config.EngineOptions.KimiModelOverride
		}
		if in.Config.EngineOptions.ReasoningEffortOverride != nil {
			effort = *in.Config.EngineOptions.ReasoningEffortOverride
		}
		if in.Config.EngineOptions.KimiReasoningEffortOverride != nil {
			effort = *in.Config.EngineOptions.KimiReasoningEffortOverride
		}
	}
	if value := nativeArgument(in.LaunchArgs, "--model", "-m"); value != "" {
		model = value
	}
	if value := nativeArgument(in.LaunchArgs, "--reasoning-effort", "--effort"); value != "" {
		effort = value
	}
	model, effort = strings.TrimSpace(model), strings.TrimSpace(effort)
	// These defaults were verified against the native 1.0.46 subscription
	// catalog (live /v1/models default_model, 2026-10-03).
	if model == "" {
		model = "kimi-code/kimi-for-coding"
	}
	if effort == "" && hasArg([]string{model}, "kimi-4.7", "kimi-4.7-build-fast", "kimi-4.6", "kimi-4.5") {
		effort = "high"
	}
	return model, effort, nil
}

func applyRuntimeModelPolicy(cfg *config.Config, args []string, rt *native.Runtime, stderr io.Writer) ([]string, error) {
	prefs := rt.ModelPreferences()
	return modelpolicy.ApplyWithPreferences(cfg, args, rt.Home, nil, stderr, modelpolicy.Preferences{Model: prefs.Model, Effort: prefs.Effort})
}

// Inspect only native options; prompt bodies and tokens after -- are data.
func nativeArgument(args []string, names ...string) string {
	return nativeargs.Value("kimi", args, names...)
}
func nativeFlag(args []string, name string) bool { return nativeargs.Has("kimi", args, name) }
func nativeCommand(args []string) string {
	command, _ := nativeargs.Command("kimi", args)
	return command
}
func nativeVersionCommand(args []string) bool {
	command := nativeCommand(args)
	return command == "version" || command == "v"
}

func interactiveArgs(args []string, headless, skipBoot bool) []string { return args }

// refusalLabel renders launchRefusal for the status and boot screens, marking
// the fleet master switch as "suspended (fleet)".
func refusalLabel(cfg *config.Config, authErr error) string {
	refusal := launchRefusal(cfg, authErr)
	if refusal == nil {
		return ""
	}
	if refusal.Error() == config.FleetDisabledMessage(config.EngineKimi) {
		return "suspended (fleet): " + refusal.Error()
	}
	return refusal.Error()
}
