package grok

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
	"github.com/pelletier/go-toml"
)

// The runtime consumes Projection only. Presentation metadata never becomes
// part of the native credential file or an auth upload.
type startupAuth struct {
	native.Projection
	APICalls int64                        `json:"api_calls"`
	Versions *orchestrator.VersionSummary `json:"versions"`
	Host     *startupHost                 `json:"host"`
}

type startupHost struct {
	FQDN        string   `json:"fqdn"`
	Secure      bool     `json:"secure"`
	APICalls    int64    `json:"api_calls"`
	Engines     string   `json:"engines"`
	EnginesList []string `json:"engines_list"`
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
	LaunchArgs     []string
	Sync           managedSyncSummary
	StatusOnly     bool
	Minimal        bool
}

func startupScreen(in startupInput) terminalui.ScreenInput {
	ui := terminalui.ScreenInput{
		Prefix: "cgx", EngineName: "grok", SkipBanner: in.Minimal,
		WrapperVersion: in.WrapperVersion, EngineVersion: in.EngineVersion,
		WrapperTone: terminalui.ToneOK, EngineTone: terminalui.ToneOK,
		QuotaNote:   "Subscription quota usage is unavailable.",
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
		ui.ResultLabel, ui.ResultTone = "Grok missing or unavailable; run `cgx update`.", terminalui.ToneFail
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
	if in.Auth == nil || in.AuthErr != nil || in.Auth.VerificationState != "verified" ||
		!hasArg([]string{in.Auth.Status}, "valid", "outdated", "updated", "ok", "unchanged") {
		authTone = terminalui.ToneFail
		ui.ResultLabel, ui.ResultTone = "Subscription auth unavailable; run `cgx login`.", terminalui.ToneFail
		if status := orchestrator.InsecureStatusFromError(in.AuthErr); status == "insecure" {
			ui.ResultLabel = "Insecure host approval pending; open Admin → Host Detail."
		} else if status == "insecure-denied" {
			ui.ResultLabel = "Insecure host approval was denied."
		}
	}
	if in.VersionErr != nil {
		ui.ResultLabel = "Grok missing or unavailable; run `cgx update`."
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
			ui.ResultLabel, ui.ResultTone = "Ready with warnings; run `cgx doctor` for details.", terminalui.ToneWarn
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
		ui.ResultLabel, ui.ResultTone = "Native settings could not be read; run `cgx doctor`.", terminalui.ToneWarn
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
	ui.BypassPermissions = nativeArgument(in.LaunchArgs, "--permission-mode") == "bypassPermissions" || nativeFlag(in.LaunchArgs, "--always-approve")
	return ui
}

func leasedStartupAuth(initial startupAuth, lease *accountpool.LeaseResponse) startupAuth {
	if lease != nil {
		initial.Projection = native.Projection{Status: "valid", Auth: lease.Auth, AccountID: lease.AccountID, VerificationState: lease.VerificationState, AccountPool: true}
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
	if !in.EffectiveHome {
		if inline := strings.TrimSpace(os.Getenv("GROK_CONFIG")); inline != "" {
			var overlay map[string]any
			if err := json.Unmarshal([]byte(inline), &overlay); err != nil {
				return "", "", errors.New("invalid Grok config overlay")
			}
			merge(settings, overlay)
		} else if path := strings.TrimSpace(os.Getenv("GROK_CONFIG_PATH")); path != "" {
			raw, err := os.ReadFile(path)
			if err != nil {
				return "", "", errors.New("Grok config overlay unavailable")
			}
			var overlay map[string]any
			if json.Unmarshal(raw, &overlay) != nil {
				tree, err := toml.LoadBytes(raw)
				if err != nil {
					return "", "", errors.New("invalid Grok config overlay")
				}
				overlay = tree.ToMap()
			}
			merge(settings, overlay)
		}
	}
	models, _ := settings["models"].(map[string]any)
	model, _ := models["default"].(string)
	effort, _ := models["default_reasoning_effort"].(string)
	if !in.EffectiveHome && in.Config != nil {
		if in.Config.EngineOptions.ModelOverride != nil {
			model = *in.Config.EngineOptions.ModelOverride
		}
		if in.Config.EngineOptions.GrokModelOverride != nil {
			model = *in.Config.EngineOptions.GrokModelOverride
		}
		if in.Config.EngineOptions.ReasoningEffortOverride != nil {
			effort = *in.Config.EngineOptions.ReasoningEffortOverride
		}
		if in.Config.EngineOptions.GrokReasoningEffortOverride != nil {
			effort = *in.Config.EngineOptions.GrokReasoningEffortOverride
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
		model = "grok-4.7"
	}
	if effort == "" && hasArg([]string{model}, "grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5") {
		effort = "high"
	}
	return model, effort, nil
}

// Inspect only native options; prompt bodies and tokens after -- are data.
func nativeArgument(args []string, names ...string) string {
	value := ""
	for i := 0; i < len(args); i++ {
		if args[i] == "--" {
			break
		}
		for _, name := range names {
			if args[i] == name && i+1 < len(args) {
				value = args[i+1]
			} else if strings.HasPrefix(args[i], name+"=") {
				value = strings.TrimPrefix(args[i], name+"=")
			} else if len(name) == 2 && name[0] == '-' && strings.HasPrefix(args[i], name) && len(args[i]) > 2 {
				value = strings.TrimPrefix(args[i], name)
			}
		}
		if nativeTakesValue(args[i]) {
			i++
		}
	}
	return value
}

func nativeTakesValue(arg string) bool {
	return hasArg([]string{arg}, "--model", "-m", "--reasoning-effort", "--effort", "--single", "-p", "--prompt-file", "--prompt-json", "--system-prompt-override", "--system-prompt", "--rules", "--agent", "--agents", "--cwd", "--leader-socket", "--permission-mode", "--allow", "--deny", "--tools", "--disallowed-tools", "--session-id", "-s") && !strings.Contains(arg, "=")
}

func nativeFlag(args []string, name string) bool {
	for i := 0; i < len(args); i++ {
		if args[i] == "--" {
			break
		}
		if args[i] == name {
			return true
		}
		if nativeTakesValue(args[i]) {
			i++
		}
	}
	return false
}

func interactiveArgs(args []string, headless, skipBoot bool) []string {
	if headless || skipBoot || nativeFlag(args, "--no-alt-screen") || nativeFlag(args, "--minimal") {
		return args
	}
	// The native default enters the alternate screen after printing the wrapper
	// card. Inline mode keeps the managed summary visible in normal scrollback.
	return append([]string{"--no-alt-screen"}, args...)
}
