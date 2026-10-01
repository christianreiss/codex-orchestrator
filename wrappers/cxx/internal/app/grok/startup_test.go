package grok

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

func textPointer(value string) *string { return &value }

func startupFixture(t *testing.T) startupInput {
	t.Helper()
	t.Setenv("GROK_CONFIG", "")
	t.Setenv("GROK_CONFIG_PATH", "")
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("[models]\ndefault='grok-4.6'\ndefault_reasoning_effort='high'\n[mcp_servers.cgx]\nurl='https://fleet.invalid/mcp'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Engine: config.EngineGrok, Host: config.Host{FQDN: "signed.example", Secure: true, BrowserOSMCPEnabled: true}, EngineOptions: config.EngineOptions{AdminThemeHint: textPointer("dark")}}
	auth := &startupAuth{Projection: native.Projection{Status: "outdated", VerificationState: "verified", CanonicalGeneration: 8}, APICalls: 12345, Host: &startupHost{FQDN: "current.example", APICalls: 9, Secure: false}, Versions: &orchestrator.VersionSummary{ClientVersion: textPointer("1.0.47"), WrapperVersion: textPointer("0.9.13"), RunnerState: textPointer("ok")}}
	return startupInput{Config: cfg, Auth: auth, Home: home, EffectiveHome: true, EngineVersion: "1.0.46", WrapperVersion: "0.9.12", Sync: managedSyncSummary{Skills: resourceSync{Checked: true}, Config: resourceSync{Checked: true, Updated: true}, Sessions: &orchestrator.FleetSessions{Now: 2, Today: 43, Month: 87}}}
}

func TestStartupScreenUsesActualLaunchAndServerEvidence(t *testing.T) {
	in := startupFixture(t)
	in.LaunchArgs = []string{"-m", "grok-4.5", "--effort=xhigh"}
	ui := startupScreen(in)
	if ui.Model != "grok-4.5" || ui.Effort != "xhigh" || ui.Theme != "dark" || ui.HostFQDN != "current.example" || !ui.Insecure || ui.APICalls != 12345 {
		t.Fatalf("launch metadata missing: %+v", ui)
	}
	if ui.EngineTarget != "1.0.47" || ui.WrapperTarget != "0.9.13" || ui.ResultTone != terminalui.ToneWarn {
		t.Fatalf("update targets missing: %+v", ui)
	}
	if ui.BrowserOS || len(ui.QuotaRows) != 0 || ui.QuotaWarn != "" || ui.QuotaBlock != "" || ui.QuotaNote == "" {
		t.Fatalf("invented provider/browser facts: %+v", ui)
	}
	want := []terminalui.HealthDot{{Name: "api", Tone: terminalui.ToneOK}, {Name: "auth", Tone: terminalui.ToneOK}, {Name: "skills", Tone: terminalui.ToneOK}, {Name: "config", Tone: terminalui.ToneOK, Updated: true}, {Name: "runner", Tone: terminalui.ToneOK}, {Name: "mcp", Tone: terminalui.ToneDim}}
	if !reflect.DeepEqual(ui.Dots, want) {
		t.Fatalf("health evidence: %+v", ui.Dots)
	}
	wantActivity := []terminalui.SessionRow{{Label: "hosts 30m", Count: 2}, {Label: "syncs UTC day", Count: 43}, {Label: "syncs UTC month", Count: 87}}
	if !reflect.DeepEqual(ui.SessionRows, wantActivity) {
		t.Fatalf("historical sync activity changed meaning: %+v", ui.SessionRows)
	}
}

func TestStartupCurrentVersionsAndUnknownQuotaRemainReady(t *testing.T) {
	in := startupFixture(t)
	in.Auth.Versions.ClientVersion = textPointer("1.0.45")
	in.Auth.Versions.WrapperVersion = textPointer(in.WrapperVersion)
	ui := startupScreen(in)
	if ui.EngineTarget != "" || ui.ResultTone != terminalui.ToneOK || ui.EngineTone != terminalui.ToneOK {
		t.Fatalf("newer accepted version or unsupported quota caused warning: %+v", ui)
	}
	in.Auth.Versions.WrapperVersion = textPointer("0.9.11")
	if ui := startupScreen(in); ui.WrapperTarget != "" || ui.ResultTone != terminalui.ToneOK {
		t.Fatalf("newer local wrapper was marked outdated: %+v", ui)
	}
	in.Auth.Versions.ClientVersionOverride = textPointer("1.0.46")
	in.EngineVersion = "1.0.47"
	in.Auth.Versions.ClientVersionEnforceExact = true
	if ui := startupScreen(in); ui.EngineTarget != "1.0.46" || ui.EngineTone != terminalui.ToneWarn {
		t.Fatalf("exact downgrade target omitted: %+v", ui)
	}
}

func TestStartupUnprobedResourcesAndMCPStayUnknown(t *testing.T) {
	in := startupFixture(t)
	in.Auth.Versions = nil
	in.Sync = managedSyncSummary{Concurrent: true}
	ui := startupScreen(in)
	if !ui.Concurrent || ui.ConcurrentNote == "" || len(ui.SessionRows) != 0 {
		t.Fatalf("concurrent sync missing: %+v", ui)
	}
	for _, dot := range ui.Dots[2:] {
		if dot.Tone != terminalui.ToneDim || dot.Updated {
			t.Fatalf("unprobed %s was optimistic: %+v", dot.Name, dot)
		}
	}
	in.StatusOnly, in.Minimal = true, true
	ui = startupScreen(in)
	if !ui.SkipBanner || len(ui.Dots) != 4 {
		t.Fatalf("status advertised a sync: %+v", ui)
	}
	for _, dot := range ui.Dots {
		if dot.Name == "config" || dot.Name == "skills" {
			t.Fatal("read-only status claimed managed resource synchronization")
		}
	}
}

func TestStartupFailuresNeverAppearReady(t *testing.T) {
	for _, condition := range []string{"auth_error", "auth_nil", "unverified", "missing", "native_missing"} {
		t.Run(condition, func(t *testing.T) {
			in := startupFixture(t)
			switch condition {
			case "auth_error":
				in.AuthErr = errors.New("transport unavailable")
			case "auth_nil":
				in.Auth = nil
			case "unverified":
				in.Auth.VerificationState = "stale"
			case "missing":
				in.Auth.Status = "missing"
			case "native_missing":
				in.VersionErr = errors.New("native missing")
			}
			if ui := startupScreen(in); ui.ResultTone != terminalui.ToneFail {
				t.Fatalf("failure appeared ready: %+v", ui)
			}
		})
	}
}

func TestStartupPreferencesReflectOverlaySignedConfigAndCLI(t *testing.T) {
	in := startupFixture(t)
	in.EffectiveHome = false
	t.Setenv("GROK_CONFIG", `{"models":{"default":"grok-4.5","default_reasoning_effort":"low"}}`)
	model, effort, err := startupPreferences(in)
	if err != nil || model != "grok-4.5" || effort != "low" {
		t.Fatalf("process overlay missing: %s/%s %v", model, effort, err)
	}
	in.Config.EngineOptions.GrokModelOverride, in.Config.EngineOptions.GrokReasoningEffortOverride = textPointer("grok-4.6"), textPointer("medium")
	model, effort, err = startupPreferences(in)
	if err != nil || model != "grok-4.6" || effort != "medium" {
		t.Fatalf("signed host override missing: %s/%s %v", model, effort, err)
	}
	in.LaunchArgs = []string{"--model=grok-4.5", "--reasoning-effort", "high"}
	model, effort, err = startupPreferences(in)
	if err != nil || model != "grok-4.5" || effort != "high" {
		t.Fatalf("native argv missing: %s/%s %v", model, effort, err)
	}
	in.EffectiveHome = true
	t.Setenv("GROK_CONFIG", "invalid overlay changed after snapshot")
	in.LaunchArgs = nil
	model, effort, err = startupPreferences(in)
	if err != nil || model != "grok-4.6" || effort != "high" {
		t.Fatalf("finalized runtime config was replaced by unrelated process state: %s/%s %v", model, effort, err)
	}
}

func TestStartupPreferencesReadsPathOverlayAndKeepsUnknownEffort(t *testing.T) {
	in := startupFixture(t)
	in.EffectiveHome = false
	path := filepath.Join(t.TempDir(), "overlay.toml")
	if err := os.WriteFile(path, []byte("[models]\ndefault='grok-4.5'\ndefault_reasoning_effort='medium'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GROK_CONFIG_PATH", path)
	model, effort, err := startupPreferences(in)
	if err != nil || model != "grok-4.5" || effort != "medium" {
		t.Fatalf("TOML path overlay missing: %s/%s %v", model, effort, err)
	}
	in.Home, in.EffectiveHome = t.TempDir(), true
	in.LaunchArgs = []string{"--model", "future-model"}
	model, effort, err = startupPreferences(in)
	if err != nil || model != "future-model" || effort != "" {
		t.Fatalf("invented unknown model effort: %s/%s %v", model, effort, err)
	}
	in.LaunchArgs = nil
	model, effort, err = startupPreferences(in)
	if err != nil || model != "grok-4.6" || effort != "high" {
		t.Fatalf("verified native defaults missing: %s/%s %v", model, effort, err)
	}
}

func TestNativeArgumentNeverReadsPromptOrTerminatorData(t *testing.T) {
	for _, args := range [][]string{{"-p", "--model=forged"}, {"--prompt-json", "--model=forged"}, {"--", "--model=forged"}} {
		if actual := nativeArgument(args, "--model", "-m"); actual != "" {
			t.Fatalf("read prompt as model: %v -> %q", args, actual)
		}
	}
	if actual := nativeArgument([]string{"--model", "grok-4.5", "-m", "grok-4.6"}, "--model", "-m"); actual != "grok-4.6" {
		t.Fatalf("native option precedence lost: %s", actual)
	}
	if actual := nativeArgument([]string{"-mgrok-4.5"}, "--model", "-m"); actual != "grok-4.5" {
		t.Fatalf("attached native short model lost: %s", actual)
	}
	for _, args := range [][]string{{"-p", "--always-approve"}, {"--", "--always-approve"}} {
		if nativeFlag(args, "--always-approve") {
			t.Fatalf("prompt data became a permission warning: %v", args)
		}
	}
}

func TestStartupAuthUsesSelectedLeaseAndRetainsFleetMetadata(t *testing.T) {
	in := startupFixture(t)
	in.Auth.AccountID, in.Auth.VerificationState = 3, "stale"
	lease := &accountpool.LeaseResponse{AccountID: 7, VerificationState: "verified", Auth: json.RawMessage(`{"grok_auth":{"selected":{"auth_mode":"external"}}}`)}
	selected := leasedStartupAuth(*in.Auth, lease)
	if selected.AccountID != 7 || selected.Status != "valid" || selected.VerificationState != "verified" || !bytes.Equal(selected.Auth, lease.Auth) || selected.Versions != in.Auth.Versions || selected.Host != in.Auth.Host || selected.APICalls != in.Auth.APICalls {
		t.Fatalf("summary retained an unselected account or lost fleet metadata: %+v", selected)
	}
	in.Auth = &selected
	if ui := startupScreen(in); ui.Dots[1].Tone != terminalui.ToneOK {
		t.Fatalf("verified selected account rendered stale: %+v", ui)
	}
}

func TestInteractiveArgumentsKeepBannerInScrollbackAndPreserveNativeChoices(t *testing.T) {
	if got := interactiveArgs([]string{"--model", "grok-4.6"}, false, false); got[0] != "--no-alt-screen" {
		t.Fatalf("visible banner will be hidden: %v", got)
	}
	for _, tc := range []struct {
		args             []string
		headless, silent bool
	}{{[]string{"--minimal"}, false, false}, {[]string{"--no-alt-screen"}, false, false}, {[]string{"-p", "prompt"}, true, false}, {[]string{"--fullscreen"}, false, true}} {
		if got := interactiveArgs(tc.args, tc.headless, tc.silent); !reflect.DeepEqual(got, tc.args) {
			t.Fatalf("native/headless/silent choice changed: %+v -> %v", tc, got)
		}
	}
	got := interactiveArgs([]string{"--fullscreen"}, false, false)
	if !hasArg(got, "--fullscreen") || !hasArg(got, "--no-alt-screen") {
		t.Fatalf("fullscreen layout flag lost: %v", got)
	}
}

func TestSyncLockContentionNeverReportsResourcesSynced(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	lock, err := ipc.TryAcquireExclusive("cgx-sync")
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	summary, err := syncMeasuredManaged(context.Background(), &config.Config{}, &orchestrator.Client{})
	if !errors.Is(err, ipc.ErrHeld) || summary.Config.Checked || summary.Skills.Checked || summary.Sessions != nil {
		t.Fatalf("contended sync claimed evidence: %+v %v", summary, err)
	}
}

func TestDoctorSummaryDisplaysLiveMetadataWithoutTouchingCredentials(t *testing.T) {
	in := startupFixture(t)
	t.Setenv("GROK_HOME", in.Home)
	original := []byte("native auth must not be read or changed by doctor\n")
	if err := os.WriteFile(filepath.Join(in.Home, "auth.json"), original, 0o600); err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(t.TempDir(), "grok")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf 'grok 1.0.46 (fixture)\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CGX_GROK_BIN", cli)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth" {
			t.Errorf("doctor performed a content/lease mutation: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(in.Auth)
	}))
	defer server.Close()
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	var out bytes.Buffer
	if err := status(context.Background(), in.Config, client, true, options{minimal: true}, &out); err != nil {
		t.Fatalf("%v: %s", err, out.String())
	}
	for _, wanted := range []string{"cgx |", "grok=1.0.46->1.0.47", "model=grok-4.6/high", "calls=12,345", "health | api=ok | auth=ok | runner=ok | mcp=unknown", "quota | Subscription quota usage is unavailable."} {
		if !strings.Contains(out.String(), wanted) {
			t.Fatalf("doctor summary omitted %q: %s", wanted, out.String())
		}
	}
	actual, err := os.ReadFile(filepath.Join(in.Home, "auth.json"))
	if err != nil || !bytes.Equal(actual, original) {
		t.Fatal("doctor touched native credentials")
	}
}

func TestExplicitStatusMinimalFlagsRetainCompactRequest(t *testing.T) {
	for _, args := range [][]string{{"status", "--minimal"}, {"--doctor", "--minimal-output"}, {"--minimal-output", "--status"}} {
		o, err := parse(args)
		if err != nil || !o.minimal {
			t.Fatalf("compact status flag lost: %v -> %+v %v", args, o, err)
		}
	}
}
