package kimi

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
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentportal"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/kimi"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/quotaemulation"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

func textPointer(value string) *string { return &value }

func startupFixture(t *testing.T) startupInput {
	t.Helper()
	t.Setenv("KIMI_CONFIG", "")
	t.Setenv("KIMI_CONFIG_PATH", "")
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("default_model='kimi-4.6'\n[thinking]\neffort='high'\n[mcp_servers.ckx]\nurl='https://fleet.invalid/mcp'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Engine: config.EngineKimi, Host: config.Host{FQDN: "signed.example", Secure: true, BrowserOSMCPEnabled: true}, EngineOptions: config.EngineOptions{AdminThemeHint: textPointer("dark")}}
	auth := &startupAuth{Projection: native.Projection{Status: "outdated", VerificationState: "verified", CanonicalGeneration: 8}, APICalls: 12345, Host: &startupHost{FQDN: "current.example", APICalls: 9, Secure: false}, Versions: &orchestrator.VersionSummary{ClientVersion: textPointer("2.5.2"), WrapperVersion: textPointer("0.9.13"), RunnerState: textPointer("ok")}}
	return startupInput{Config: cfg, Auth: auth, Home: home, EffectiveHome: true, EngineVersion: "2.5.1", WrapperVersion: "0.9.12", Sync: managedSyncSummary{Skills: resourceSync{Checked: true}, Config: resourceSync{Checked: true, Updated: true}, Sessions: &orchestrator.FleetSessions{Now: 2, Today: 43, Month: 87}}}
}

func TestStartupScreenUsesActualLaunchAndServerEvidence(t *testing.T) {
	in := startupFixture(t)
	in.LaunchArgs = []string{"-m", "kimi-4.5", "--auto"}
	ui := startupScreen(in)
	if ui.Model != "kimi-4.5" || ui.Effort != "high" || ui.Theme != "dark" || ui.HostFQDN != "current.example" || !ui.Insecure || ui.APICalls != 12345 {
		t.Fatalf("launch metadata missing: %+v", ui)
	}
	if ui.EngineTarget != "2.5.2" || ui.WrapperTarget != "0.9.13" || ui.ResultTone != terminalui.ToneWarn {
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

func TestKimiQuotaWindowsUseServerReading(t *testing.T) {
	in := startupFixture(t)
	used := 38.0
	reset := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	in.Auth.KimiUsage = &kimiUsageReading{Windows: []kimiUsageWindow{{Kind: "five_hour", UsedPercent: &used, ResetsAt: &reset}, {Kind: "weekly", UsedPercent: &used, ResetsAt: &reset}}}
	ui := startupScreen(in)
	if len(ui.QuotaRows) != 2 || ui.QuotaRows[0].Label != "5h" || ui.QuotaRows[1].Used != 38 || ui.QuotaNote != "" {
		t.Fatalf("%+v", ui)
	}
	expired := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	in.Auth.KimiUsage.Windows[0].ResetsAt = &expired
	in.Auth.KimiUsage.Windows[1].UsedPercent = nil
	if ui := startupScreen(in); len(ui.QuotaRows) != 0 || ui.QuotaNote != "Subscription quota usage is unavailable." {
		t.Fatalf("%+v", ui)
	}
	var auth startupAuth
	if err := json.Unmarshal([]byte(`{"kimi_usage":{"windows":[],"plan_name":null,"fetched_at":null,"error_code":null}}`), &auth); err != nil {
		t.Fatal(err)
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
	in.Auth.Versions.ClientVersionOverride = textPointer("2.5.1")
	in.EngineVersion = "2.5.2"
	in.Auth.Versions.ClientVersionEnforceExact = true
	if ui := startupScreen(in); ui.EngineTarget != "2.5.1" || ui.EngineTone != terminalui.ToneWarn {
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

func TestNativeArgumentNeverReadsPromptOrTerminatorData(t *testing.T) {
	for _, args := range [][]string{{"-p", "--model=forged"}, {"--prompt", "--model=forged"}, {"--", "--model=forged"}} {
		if actual := nativeArgument(args, "--model", "-m"); actual != "" {
			t.Fatalf("read prompt as model: %v -> %q", args, actual)
		}
	}
	if actual := nativeArgument([]string{"--model", "kimi-4.5", "-m", "kimi-4.6"}, "--model", "-m"); actual != "kimi-4.6" {
		t.Fatalf("native option precedence lost: %s", actual)
	}
	if actual := nativeArgument([]string{"-mkimi-4.5"}, "--model", "-m"); actual != "kimi-4.5" {
		t.Fatalf("attached native short model lost: %s", actual)
	}
	for _, args := range [][]string{{"-p", "--auto"}, {"--", "--auto"}} {
		if nativeFlag(args, "--auto") {
			t.Fatalf("prompt data became a permission warning: %v", args)
		}
	}
}

func TestStartupAuthUsesSelectedLeaseAndRetainsFleetMetadata(t *testing.T) {
	in := startupFixture(t)
	in.Auth.AccountID, in.Auth.VerificationState = 3, "stale"
	lease := &accountpool.LeaseResponse{AccountID: 7, VerificationState: "verified", Auth: json.RawMessage(`{"kimi_auth":{"selected":{"auth_mode":"external"}}}`)}
	selected := leasedStartupAuth(*in.Auth, lease)
	if selected.AccountID != 7 || selected.Status != "valid" || selected.VerificationState != "verified" || !bytes.Equal(selected.Auth, lease.Auth) || selected.Versions != in.Auth.Versions || selected.Host != in.Auth.Host || selected.APICalls != in.Auth.APICalls {
		t.Fatalf("summary retained an unselected account or lost fleet metadata: %+v", selected)
	}
	in.Auth = &selected
	if ui := startupScreen(in); ui.Dots[1].Tone != terminalui.ToneOK {
		t.Fatalf("verified selected account rendered stale: %+v", ui)
	}
}

func TestSyncLockContentionNeverReportsResourcesSynced(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	lock, err := ipc.TryAcquireExclusive("ckx-sync")
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
	t.Setenv("KIMI_CODE_HOME", in.Home)
	original := []byte("native auth must not be read or changed by doctor\n")
	if err := os.WriteFile(filepath.Join(in.Home, "auth.json"), original, 0o600); err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(t.TempDir(), "kimi")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf 'kimi 2.5.1 (fixture)\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CKX_KIMI_BIN", cli)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth" {
			t.Errorf("doctor performed a content/lease mutation: %s", r.URL.Path)
		}
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload["metadata_only"] != true {
			t.Error("doctor requested rotating subscription credentials")
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
	for _, wanted := range []string{"ckx |", "kimi=2.5.1->2.5.2", "model=kimi-4.6/high", "calls=12,345", "health | api=ok | auth=ok | runner=ok | mcp=unknown", "quota | Subscription quota usage is unavailable."} {
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

func TestStartupMetadataLetsPoolChooseHealthyAccountAfterStaleBinding(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var seenAcquire bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/auth":
			if body["metadata_only"] != true {
				t.Error("startup attempted credential refresh")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"account_pool": true, "metadata_only": true, "status": "missing", "verification_state": "failed"})
		case "/auth/sessions":
			seenAcquire = true
			if _, pinned := body["account_id"]; pinned {
				t.Error("new private launch pinned failed previous account")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"account_id": 2, "session_id": body["session_id"], "verification_state": "verified", "auth": map[string]any{"fixture": "access-only"}})
		case "/auth/sessions/release":
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		default:
			t.Errorf("unexpected route %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	pool := accountpool.Load("kimi", filepath.Join(t.TempDir(), "auth.json"), srv.URL)
	pool.AccountID = 1
	client := &orchestrator.Client{BaseURL: srv.URL, HTTP: srv.Client(), Pool: pool}
	if _, err := retrieveStartupAuth(context.Background(), client, true, true, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	release, lease, err := pool.Start(context.Background(), client, false, func(json.RawMessage, string, bool) (bool, error) { return true, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if !seenAcquire || lease.AccountID != 2 {
		t.Fatal("healthy pool account was unreachable")
	}
}

// The server answers status/doctor's metadata_only /auth with
// status "available"|"missing" (docs/interface-api.md), never "valid": a stored,
// verified login must read as healthy, and only that.
func TestStatusAcceptsServerMetadataShape(t *testing.T) {
	for _, tc := range []struct {
		name, status, verification string
		pool                       int
		ok                         bool
	}{
		{"available_verified", "available", "verified", 0, true},
		{"available_unverified", "available", "failed", 0, false},
		{"missing", "missing", "unknown", 0, false},
		// A launch leases from the pool, so an empty account-less head is no outage.
		{"missing_head_leasable_pool", "missing", "unknown", 1, true},
		{"failed_head_leasable_pool", "available", "failed", 2, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := startupFixture(t)
			t.Setenv("KIMI_CODE_HOME", in.Home)
			cli := filepath.Join(t.TempDir(), "kimi")
			if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf 'kimi 2.5.1\\n'\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("CKX_KIMI_BIN", cli)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if r.URL.Path != "/auth" || body["metadata_only"] != true {
					t.Errorf("status made a non-metadata request: %s %v", r.URL.Path, body)
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"account_pool": true, "metadata_only": true, "status": tc.status, "verification_state": tc.verification, "canonical_generation": 3, "pool_verified_accounts": tc.pool})
			}))
			defer srv.Close()
			client := &orchestrator.Client{BaseURL: srv.URL, HTTP: srv.Client()}
			var out bytes.Buffer
			err := status(context.Background(), in.Config, client, false, options{minimal: true}, &out)
			if tc.ok && (err != nil || !strings.Contains(out.String(), "auth=ok")) {
				t.Fatalf("stored verified login reported unavailable: %v\n%s", err, out.String())
			}
			if !tc.ok && (err == nil || !strings.Contains(out.String(), "auth=fail")) {
				t.Fatalf("unusable login reported healthy: %v\n%s", err, out.String())
			}
			out.Reset()
			err = status(context.Background(), in.Config, client, true, options{minimal: true}, &out)
			if (err == nil) != tc.ok {
				t.Fatalf("doctor verdict %v disagrees with status (want ok=%v):\n%s", err, tc.ok, out.String())
			}
		})
	}
}

func TestLeasedGrantSupersedesPoolAvailability(t *testing.T) {
	in := startupFixture(t)
	initial := *in.Auth
	initial.Status, initial.VerificationState, initial.PoolVerifiedAccounts = "missing", "unknown", 3
	for _, tc := range []struct {
		verification string
		ok           bool
	}{{"verified", true}, {"pending", false}, {"failed", false}} {
		leased := leasedStartupAuth(initial, &accountpool.LeaseResponse{AccountID: 7, VerificationState: tc.verification})
		if leased.PoolVerifiedAccounts != 0 {
			t.Fatalf("lease kept metadata pool count: %+v", leased)
		}
		in.Auth = &leased
		if ok := startupScreen(in).Dots[1].Tone != terminalui.ToneFail; ok != tc.ok {
			t.Fatalf("%s lease rendered auth ok=%v, want %v", tc.verification, ok, tc.ok)
		}
	}
}

func TestLeasedQuotaSnapshotNeverRetainsAnotherAccountReading(t *testing.T) {
	old := &quotaemulation.Snapshot{Unlimited: true}
	for _, selected := range []*quotaemulation.Snapshot{nil, {Unlimited: false}} {
		initial := startupAuth{QuotaSnapshot: old}
		got := leasedStartupAuth(initial, &accountpool.LeaseResponse{AccountID: 7, QuotaSnapshot: selected})
		if got.QuotaSnapshot != selected || initial.QuotaSnapshot != old {
			t.Fatal("selected account did not own the quota display")
		}
	}
}

func TestServerUsageWireShapes(t *testing.T) {
	now := time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)
	raw, err := os.ReadFile("../../kimi/testdata/server-usage.json")
	if err != nil {
		t.Fatal(err)
	}
	var auth startupAuth
	if err := json.Unmarshal(raw, &auth); err != nil {
		t.Fatal(err)
	}
	if auth.KimiUsage == nil || auth.KimiUsage.PlanName == nil || *auth.KimiUsage.PlanName != "Moderato" || len(auth.KimiUsage.Windows) != 4 || *auth.KimiUsage.Windows[0].UsedPercent != 38.25 || auth.KimiUsage.Windows[3].ResetsAt != nil {
		t.Fatalf("server auth/admin shape lost: %+v", auth.KimiUsage)
	}
	rows := kimiQuotaRows(auth.KimiUsage, now)
	if len(rows) != 3 || rows[0].Used != 38 || rows[1].Used != 63 || rows[2].Label != "month total" {
		t.Fatalf("server quota rows: %+v", rows)
	}
	raw, err = os.ReadFile("../../kimi/testdata/server-lease.json")
	if err != nil {
		t.Fatal(err)
	}
	var lease accountpool.LeaseResponse
	if err := json.Unmarshal(raw, &lease); err != nil {
		t.Fatal(err)
	}
	leased := leasedStartupAuth(startupAuth{}, &lease)
	if !reflect.DeepEqual(leased.KimiUsage, auth.KimiUsage) {
		t.Fatalf("lease usage shape differs: %+v", leased.KimiUsage)
	}
	// Absence, malformed data and an unavailable reading cannot reuse another account.
	for _, reading := range []json.RawMessage{nil, json.RawMessage(`{"windows":"invalid"}`), json.RawMessage(`{"supported":false}`)} {
		lease.Usage = reading
		got := leasedStartupAuth(auth, &lease)
		if len(kimiQuotaRows(got.KimiUsage, now)) != 0 {
			t.Fatal("old account quota retained")
		}
	}
}

func TestLaunchIdentityUsesPrivateRuntimeHomeOnResume(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	base := t.TempDir()
	const fleet = "Fleet instructions\n"
	if err := os.WriteFile(filepath.Join(base, "AGENTS.md"), []byte(fleet), 0600); err != nil {
		t.Fatal(err)
	}
	rt, err := native.NewRuntime(base, &config.Config{}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	args := []string{"-S", "session_11111111-1111-4111-8111-111111111111", "-m", "kimi-code/k3"}
	got, err := agentportal.AppendKimiIdentityArgs(args, agentportal.Identity{Name: "Wiebke", Engine: "kimi", SessionID: "launch"}, rt.Home)
	if err != nil || !reflect.DeepEqual(got, args) {
		t.Fatalf("resume arguments changed: %v, %v", got, err)
	}
	overlay, err := os.ReadFile(filepath.Join(rt.Home, "AGENTS.md"))
	if err != nil || !strings.HasPrefix(string(overlay), fleet) || !strings.Contains(string(overlay), "Wiebke") {
		t.Fatalf("private identity absent: %s, %v", overlay, err)
	}
	unchanged, err := os.ReadFile(filepath.Join(base, "AGENTS.md"))
	if err != nil || string(unchanged) != fleet {
		t.Fatal("launch overwrote shared fleet instructions", err)
	}
}
