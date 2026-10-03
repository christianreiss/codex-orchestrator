package lifecycle

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

const (
	claudeFleetDisabled = "Claude is disabled fleet-wide by the administrator."
	claudeHostDisabled  = "Claude is disabled for this host by the administrator."
)

// engineSwitchHost is a host with fresh cached credentials and fleet-owned
// settings (a managed "model" key next to a user key), talking to an
// orchestrator that answers every request with status/body; status 0 means
// nothing listens.
func engineSwitchHost(t *testing.T, status int, body string, suspended ...string) (*config.Config, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "1")
	expires := time.Now().Add(24 * time.Hour).UnixMilli()
	if err := claude.WriteAuth(json.RawMessage(fmt.Sprintf(
		`{"last_refresh":%q,"claudeAiOauth":{"accessToken":"live","expiresAt":%d}}`,
		time.Now().UTC().Format(time.RFC3339), expires,
	))); err != nil {
		t.Fatal(err)
	}
	settings := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settings), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settings, []byte(`{"model":"fleet-model","theme":"user-choice"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := saveManagedState(managedState{Version: 1, KeyPaths: []string{"model"}, PermissionRules: map[string][]string{}}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	if status == 0 {
		server.Close()
	} else {
		t.Cleanup(server.Close)
	}
	return &config.Config{
		Engine:       config.EngineClaude,
		Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"},
		Host:         config.Host{Secure: true, EnginesList: []string{config.EngineClaude}, FleetDisabledEngines: suspended},
	}, settings
}

func runClaudeSyncOnly(t *testing.T, cfg *config.Config) (int, error) {
	t.Helper()
	return Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: true, SkipBoot: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
}

func managedModelKept(t *testing.T, settings string) bool {
	t.Helper()
	raw, err := os.ReadFile(settings)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "user-choice") {
		t.Fatalf("user-authored settings were touched: %s", raw)
	}
	owned := false
	for _, key := range loadManagedState().KeyPaths {
		owned = owned || key == "model"
	}
	return strings.Contains(string(raw), "fleet-model") && owned
}

// The fleet switch is a pause: refuse the launch, but keep every fleet-managed
// setting, collection and skill so re-enabling needs no re-sync or reinstall.
// Host-level removal keeps its trust-loss teardown.
func TestEngineDisabledScopeDecidesManagedTeardown(t *testing.T) {
	for _, tc := range []struct {
		name, body, wantReason string
		wantKept               bool
	}{
		{
			name:       "fleet switch keeps managed state",
			body:       `{"status":"error","message":"Claude is disabled fleet-wide by the administrator","code":"engine_disabled","scope":"fleet","engine":"claude"}`,
			wantReason: claudeFleetDisabled,
			wantKept:   true,
		},
		{
			name:       "host removal strips managed state",
			body:       `{"status":"error","message":"Engine claude is disabled for this host","code":"engine_disabled","scope":"host","engine":"claude"}`,
			wantReason: claudeHostDisabled,
			wantKept:   false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg, settings := engineSwitchHost(t, http.StatusForbidden, tc.body)
			exit, err := runClaudeSyncOnly(t, cfg)
			if exit == 0 || err == nil || !strings.Contains(err.Error(), tc.wantReason) {
				t.Fatalf("refusal = exit %d err %v, want %q", exit, err, tc.wantReason)
			}
			if kept := managedModelKept(t, settings); kept != tc.wantKept {
				t.Fatalf("managed settings kept=%v, want %v", kept, tc.wantKept)
			}
		})
	}
}

// Offline must not bypass the switch, and the refusal must not tear down the
// managed state either — a signed config cannot prove trust was lost.
func TestLocallySuspendedConfigRefusesWhileOfflineWithoutTeardown(t *testing.T) {
	cfg, settings := engineSwitchHost(t, 0, "", config.EngineClaude)
	exit, err := runClaudeSyncOnly(t, cfg)
	if exit == 0 || err == nil || !strings.Contains(err.Error(), claudeFleetDisabled) {
		t.Fatalf("offline launch bypassed the local suspension: exit=%d err=%v", exit, err)
	}
	if !managedModelKept(t, settings) {
		t.Fatal("an offline suspension refusal stripped managed settings")
	}
}

func TestClaudeApplyLocalSuspensionOnlyOverridesUnansweredDecisions(t *testing.T) {
	suspended := &config.Config{Host: config.Host{FleetDisabledEngines: []string{config.EngineClaude}}}
	for _, status := range []string{"offline", "error", ""} {
		dec := applyLocalSuspension(suspended, orchestrator.AuthDecision{Allowed: true, LocalUsable: true, Status: status})
		if dec.Allowed || dec.LocalUsable || dec.Status != orchestrator.AuthStatusSuspended || dec.Reason != claudeFleetDisabled {
			t.Fatalf("%q: suspension bypassed: %+v", status, dec)
		}
		if needsInteractiveAuthRecovery(dec, nil, false) {
			t.Fatalf("%q: a suspended engine opened a login prompt", status)
		}
	}
	answered := orchestrator.AuthDecision{Allowed: true, Status: "valid"}
	if got := applyLocalSuspension(suspended, answered); got != answered {
		t.Fatalf("a positive server answer (switch back on) was overridden: %+v", got)
	}
}

func TestClaudeReenabledEngineRequestsImmediateMaintenance(t *testing.T) {
	var calls []string
	prev := requestMaintenanceNow
	requestMaintenanceNow = func(engine, _ string) error { calls = append(calls, engine); return nil }
	t.Cleanup(func() { requestMaintenanceNow = prev })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	suspended := &config.Config{Host: config.Host{EnginesList: []string{config.EngineClaude}, FleetDisabledEngines: []string{config.EngineClaude}}}
	if reconcileEngineDrift(suspended, &orchestrator.AuthRetrieveResponse{Status: "offline"}, logger) || len(calls) != 0 {
		t.Fatalf("an unanswered launch claimed the switch is back on: %v", calls)
	}
	if !reconcileEngineDrift(suspended, &orchestrator.AuthRetrieveResponse{Status: "valid"}, logger) || len(calls) != 1 || calls[0] != config.EngineClaude {
		t.Fatalf("re-enabled engine did not refresh its config now: %v", calls)
	}
}
