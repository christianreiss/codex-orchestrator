package grok

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/skillstore"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

func sha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func TestSyncInstallsNativeSkillsAndAdvertisesTheirDigests(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	home := filepath.Join(t.TempDir(), "native")
	t.Setenv("GROK_HOME", home)
	const skill = "---\nname: afk\ndescription: notify then stop\n---\n\nbody\n"
	var requests []orchestrator.BundleRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/sync/bootstrap":
			var request orchestrator.BundleRequest
			_ = json.NewDecoder(r.Body).Decode(&request)
			requests = append(requests, request)
			item := map[string]any{"slug": "afk", "sha256": sha(skill), "status": "updated", "content": skill}
			if request.Skills["afk"] == sha(skill) {
				item = map[string]any{"slug": "afk", "sha256": sha(skill), "status": "unchanged"}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "data": map[string]any{
				"status": "ok", "agents": map[string]any{"status": "unchanged"}, "config": map[string]any{"status": "unchanged"},
				"grok_skills": []any{item, map[string]any{"slug": "../escape", "sha256": sha("x"), "status": "updated", "content": "x"}},
			}})
		case "/host/users":
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	}))
	defer server.Close()
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	cfg := &config.Config{Engine: config.EngineGrok}
	cfg.Host.EnginesList = []string{config.EngineGrok}
	first, err := syncMeasuredManaged(context.Background(), cfg, client)
	if err != nil {
		t.Fatalf("an unsafe skill must warn, not fail the sync: %v", err)
	}
	if !first.Skills.Updated || !first.Skills.Failed {
		t.Fatalf("first sync skills marker = %+v", first.Skills)
	}
	raw, err := os.ReadFile(filepath.Join(home, "skills", "afk", "SKILL.md"))
	if err != nil || string(raw) != skill {
		t.Fatalf("native skill not installed: %q %v", raw, err)
	}
	if _, err := syncMeasuredManaged(context.Background(), cfg, client); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 2 || requests[0].Skills["afk"] != "" || requests[1].Skills["afk"] != sha(skill) {
		t.Fatalf("digests not advertised for If-None-Match: %+v", requests)
	}
	if dot := resourceDot("skills", first.Skills); dot.Tone != terminalui.ToneWarn {
		t.Fatalf("partial skill failure shown as %s", dot.Tone)
	}
}

func TestHelpRequestsBypassLeaseAndSync(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"-h"}, {"help"}, {"mcp", "--help"}, {"sessions", "list", "-h"}} {
		if !isHelpPassthrough(args) {
			t.Fatalf("%v not passed through", args)
		}
	}
	for _, args := range [][]string{{}, {"fix the bug"}, {"-p", "--help"}, {"--", "--help"}, {"--model", "-h"}} {
		if isHelpPassthrough(args) {
			t.Fatalf("%v treated as help", args)
		}
	}
}

func TestInsecureApprovalWaitsInteractivelyAndRefusesHeadless(t *testing.T) {
	var approved atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !approved.Load() {
			w.WriteHeader(http.StatusLocked)
			_, _ = w.Write([]byte(`{"status":"error","code":"insecure_pending"}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"valid","verification_state":"verified"}`))
	}))
	defer server.Close()
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	if _, err := retrieveStartupAuth(context.Background(), client, true, true, io.Discard); err == nil || !strings.Contains(err.Error(), "Host Detail") {
		t.Fatalf("headless launch did not refuse with guidance: %v", err)
	}
	previous := pollApproval
	defer func() { pollApproval = previous }()
	pollApproval = func(ctx context.Context, checker terminalui.AuthChecker, _ time.Duration, _ bool) (bool, error) {
		if status, _, err := checker.CheckAuthStatus(ctx); err != nil || status != "insecure" {
			t.Fatalf("checker did not map 423: %s %v", status, err)
		}
		approved.Store(true)
		status, _, err := checker.CheckAuthStatus(ctx)
		return err == nil && status != "insecure", err
	}
	tty, err := os.OpenFile("/dev/null", os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer tty.Close()
	if !isTerminal(tty) {
		t.Skip("/dev/null is not a character device here")
	}
	auth, err := retrieveStartupAuth(context.Background(), client, false, true, tty)
	if err != nil || auth.Status != "valid" {
		t.Fatalf("approved launch did not continue: %+v %v", auth, err)
	}
}

func TestStatusAnsweredAuthErrorKeepsAPIHealthyAndExitsNonZero(t *testing.T) {
	in := startupFixture(t)
	t.Setenv("GROK_HOME", in.Home)
	cli := filepath.Join(t.TempDir(), "grok")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf 'grok 1.0.46\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CGX_GROK_BIN", cli)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"status":"error","code":"grok_login_required"}`))
	}))
	defer server.Close()
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	var out bytes.Buffer
	err := status(context.Background(), in.Config, client, false, options{minimal: true}, &out)
	if err == nil {
		t.Fatal("red status exited 0")
	}
	if !strings.Contains(out.String(), "api=ok") || !strings.Contains(out.String(), "auth=fail") || !strings.Contains(out.String(), "cgx login") {
		t.Fatalf("answered auth error misreported: %s", out.String())
	}
}

func TestMaintenanceReportsVersionsEvenWhenContentSyncFails(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	t.Setenv("GROK_HOME", filepath.Join(t.TempDir(), "native"))
	t.Setenv("CXX_CRON_COORDINATED", "1")
	cli := filepath.Join(t.TempDir(), "grok")
	if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf 'grok 1.0.46\\n'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CGX_GROK_BIN", cli)
	var reported atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/cron/check":
			// An older wrapper offered is a downgrade and must be skipped.
			_ = json.NewEncoder(w).Encode(orchestrator.CronCheckResponse{Action: "no_update", TargetVersion: "1.0.46", Wrapper: &orchestrator.CronWrapperBlock{Action: "update", TargetVersion: "0.0.1", SHA256: strings.Repeat("a", 64), URL: "/never"}})
		case "/sync/bootstrap":
			w.WriteHeader(http.StatusInternalServerError)
		case "/cron/report":
			reported.Add(1)
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	}))
	defer server.Close()
	previous := Version
	Version = "9.9.9"
	defer func() { Version = previous }()
	cfg := &config.Config{Engine: config.EngineGrok}
	cfg.Orchestrator.BaseURL = server.URL
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	var out bytes.Buffer
	err := maintenance(context.Background(), cfg, client, false, &out, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "managed sync unavailable") {
		t.Fatalf("sync failure not returned: %v", err)
	}
	if reported.Load() != 1 || !strings.Contains(out.String(), "cron: ok (wrapper 9.9.9, grok 1.0.46, no updates, reported=true)") {
		t.Fatalf("versions not reported before the sync error: %d %q", reported.Load(), out.String())
	}
}

func TestUninstallCleansLocalStateWhenServerDeleteFails(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	home := filepath.Join(t.TempDir(), "native")
	t.Setenv("GROK_HOME", home)
	store, err := native.Skills()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply([]skillstore.Item{{Slug: "afk", SHA256: sha("x"), Content: "x"}}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/host/users" {
			_, _ = w.Write([]byte(`{"status":"ok","data":{"users":[]}}`))
			return
		}
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	var out, errout bytes.Buffer
	if err := uninstall(context.Background(), &config.Config{}, client, &out, &errout); err != nil {
		t.Fatalf("uninstall: %v (%s)", err, errout.String())
	}
	if _, err := os.Stat(filepath.Join(home, "skills", "afk")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("fleet skill survived uninstall")
	}
	if !strings.Contains(errout.String(), "server-side delete failed") || !strings.Contains(errout.String(), "shared cxx aliases and cron preserved") {
		t.Fatalf("uninstall did not report the preserved shared state: %s", errout.String())
	}
}

func TestEngineDriftRequestsImmediateMaintenance(t *testing.T) {
	previous := requestMaintenanceNow
	defer func() { requestMaintenanceNow = previous }()
	var requested []string
	requestMaintenanceNow = func(engine, _ string) error { requested = append(requested, engine); return nil }
	cfg := &config.Config{Engine: config.EngineGrok}
	cfg.Host.EnginesList = []string{config.EngineGrok}
	same := startupAuth{Host: &startupHost{EnginesList: []string{"grok"}}}
	if reconcileEngineDrift(cfg, same, nil) || len(requested) != 0 {
		t.Fatal("unchanged engine set requested maintenance")
	}
	added := startupAuth{Host: &startupHost{Engines: "grok,claude"}}
	if !reconcileEngineDrift(cfg, added, nil) || len(requested) != 1 || requested[0] != config.EngineGrok {
		t.Fatalf("enabled engine not provisioned now: %v", requested)
	}
}

const (
	grokFleetDisabled = "Grok is disabled fleet-wide by the administrator."
	grokHostDisabled  = "Grok is disabled for this host by the administrator."
)

// grokLaunchHost runs the cgx launch path against handler until the first
// refusal; every case here refuses before a lease or native CLI is needed.
func grokLaunchHost(t *testing.T, handler http.HandlerFunc, suspended ...string) (int, error) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	t.Setenv("GROK_HOME", filepath.Join(t.TempDir(), "native"))
	server := httptest.NewServer(handler)
	if handler == nil {
		server.Close()
	} else {
		t.Cleanup(server.Close)
	}
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	cfg := &config.Config{Engine: config.EngineGrok}
	cfg.Orchestrator.BaseURL = server.URL
	cfg.Host.EnginesList = []string{config.EngineGrok}
	cfg.Host.FleetDisabledEngines = suspended
	return run(context.Background(), cfg, client, options{skipBoot: true, minimal: true}, io.Discard, io.Discard)
}

func healthyGrokSync(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/sync/bootstrap":
		_, _ = w.Write([]byte(`{"status":"ok","data":{"status":"ok","agents":{"status":"unchanged"},"config":{"status":"unchanged"}}}`))
	case "/host/users":
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	default:
		return false
	}
	return true
}

// cgx parity with cdx/clx: the fleet master switch, host removal and the API
// kill switch each refuse a launch with their own exact text, never with the
// old "run cgx login" advice.
func TestGrokLaunchRefusalsMatchCdxAndClx(t *testing.T) {
	for _, tc := range []struct {
		name    string
		handler http.HandlerFunc
		want    string
	}{
		{
			name: "fleet switch on the managed sync",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"status":"error","message":"Grok is disabled fleet-wide by the administrator","code":"engine_disabled","scope":"fleet","engine":"grok"}`))
			},
			want: grokFleetDisabled,
		},
		{
			name: "host removal on /auth",
			handler: func(w http.ResponseWriter, r *http.Request) {
				if healthyGrokSync(w, r) {
					return
				}
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"status":"error","code":"engine_disabled","scope":"host","engine":"grok"}`))
			},
			want: grokHostDisabled,
		},
		{
			name: "API kill switch as a 503",
			handler: func(w http.ResponseWriter, r *http.Request) {
				if healthyGrokSync(w, r) {
					return
				}
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"status":"error","message":"API disabled by administrator","code":"api_disabled"}`))
			},
			want: "Auth API disabled by administrator.",
		},
		{
			name: "API kill switch in the versions block",
			handler: func(w http.ResponseWriter, r *http.Request) {
				if healthyGrokSync(w, r) {
					return
				}
				_, _ = w.Write([]byte(`{"status":"valid","verification_state":"verified","versions":{"api_disabled":true}}`))
			},
			want: "Auth API disabled by administrator.",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, err := grokLaunchHost(t, tc.handler)
			if code == 0 || err == nil || err.Error() != tc.want {
				t.Fatalf("launch = %d %v, want refusal %q", code, err, tc.want)
			}
		})
	}
}

// Offline must not bypass a signed suspension; without one an outage keeps
// its existing error.
func TestGrokLocallySuspendedConfigRefusesWhileOffline(t *testing.T) {
	if code, err := grokLaunchHost(t, nil, config.EngineGrok); code == 0 || err == nil || err.Error() != grokFleetDisabled {
		t.Fatalf("offline launch bypassed the local suspension: %d %v", code, err)
	}
	if _, err := grokLaunchHost(t, nil); err == nil || strings.Contains(err.Error(), "disabled") {
		t.Fatalf("unsuspended outage changed behavior: %v", err)
	}
}

func TestGrokStatusShowsFleetSuspension(t *testing.T) {
	in := startupFixture(t)
	in.StatusOnly = true
	in.Auth = &startupAuth{}
	in.AuthErr = &orchestrator.HTTPError{StatusCode: http.StatusForbidden, Code: "engine_disabled", Scope: "fleet"}
	screen := startupScreen(in)
	if screen.ResultTone != terminalui.ToneFail || screen.ResultLabel != "suspended (fleet): "+grokFleetDisabled {
		t.Fatalf("status did not show the fleet suspension: %q", screen.ResultLabel)
	}
	report := doctorReport(doctorInput{Config: in.Config, Home: in.Home, Auth: in.Auth, AuthErr: in.AuthErr})
	engineRow := false
	for _, row := range report.Rows {
		engineRow = engineRow || (row.Label == "Engine" && row.Value == "suspended (fleet)")
	}
	for _, hint := range report.Hints {
		if strings.Contains(hint, "cgx login") {
			t.Fatalf("doctor advised a login for an administrator switch: %q", report.Hints)
		}
	}
	if !engineRow {
		t.Fatalf("doctor did not show the suspension: %+v", report.Rows)
	}
}

func TestGrokReenabledEngineRequestsImmediateMaintenance(t *testing.T) {
	previous := requestMaintenanceNow
	defer func() { requestMaintenanceNow = previous }()
	var requested []string
	requestMaintenanceNow = func(engine, _ string) error { requested = append(requested, engine); return nil }
	cfg := &config.Config{Engine: config.EngineGrok}
	cfg.Host.EnginesList = []string{config.EngineGrok}
	cfg.Host.FleetDisabledEngines = []string{config.EngineGrok}
	// reconcileEngineDrift only runs after /auth answered for Grok, which the
	// server refuses while Grok is switched off: the signed config is stale.
	if !reconcileEngineDrift(cfg, startupAuth{Host: &startupHost{EnginesList: []string{"grok"}}}, nil) || len(requested) != 1 {
		t.Fatalf("re-enabled Grok did not refresh its config now: %v", requested)
	}
}
