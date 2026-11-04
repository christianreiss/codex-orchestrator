package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/memoryrouting"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

func TestHiddenBootKeepsClaudeQuotaAdvisory(t *testing.T) {
	now := time.Now().UTC()
	reset := now.Add(5 * time.Hour).Format(time.RFC3339)
	extra := fmt.Sprintf(`,"quota_hard_fail":true,"quota_limit_percent":95,"claude_usage":{
		"status":"ok","fetched_at":%q,"five_hour_used_percent":96,"five_hour_resets_at":%q,
		"seven_day_used_percent":null,"seven_day_resets_at":null,
		"five_hour_window":{"used_percent":96,"resets_at":%q},
		"seven_day_window":{"used_percent":null,"resets_at":null}}`, now.Format(time.RFC3339), reset, reset)
	cfg, home := syncOnlyHost(t, extra)
	t.Setenv("CLX_CLAUDE_BIN", filepath.Join(home, "no-cli"))
	stderr := captureStderr(t, func() {
		exit, err := Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: true, SkipBoot: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
		if exit != 0 || err != nil {
			t.Fatalf("advisory quota blocked managed sync: exit=%d err=%v", exit, err)
		}
	})
	if !strings.Contains(stderr, "clx quota:") || !strings.Contains(stderr, "96%") {
		t.Fatalf("hidden screen omitted Claude usage warning: %q", stderr)
	}
}

func TestNativeSkillBundleAvoidsRedundantList(t *testing.T) {
	for _, scenario := range []struct {
		name       string
		advertised bool
		writeFails bool
	}{
		{name: "native_skills", advertised: true},
		{name: "legacy_server"},
		{name: "failed_native_manifest", advertised: true, writeFails: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			cfg, home := syncOnlyHost(t, "")
			t.Setenv("CLX_CLAUDE_BIN", filepath.Join(home, "no-cli"))
			if scenario.writeFails {
				if err := os.MkdirAll(collectionManifestPath("skills"), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			var listCalls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/skills" {
					listCalls.Add(1)
					// A deterministic RTT makes the avoidable startup wait visible
					// without relying on production network or credentials.
					time.Sleep(40 * time.Millisecond)
					_, _ = io.WriteString(w, `{"skills":[]}`)
					return
				}
				if r.URL.Path != "/sync/bootstrap" {
					http.NotFound(w, r)
					return
				}
				extra := ""
				if scenario.advertised {
					extra = `,"claude_skills":[]`
				}
				_, _ = fmt.Fprintf(w, `{"status":"ok","auth":{"status":"valid","verification_state":"verified","host":{"secure":true}}%s}`, extra)
			}))
			defer server.Close()
			cfg.Orchestrator.BaseURL = server.URL
			started := time.Now()
			exit, err := Run(context.Background(), Options{Config: cfg, SyncOnly: true, Headless: true, SkipBoot: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
			t.Logf("startup=%s skills_list_requests=%d", time.Since(started), listCalls.Load())
			if scenario.writeFails {
				if exit != 1 || err == nil || !strings.Contains(err.Error(), "managed sync incomplete") {
					t.Fatalf("native skill failure was hidden: exit=%d err=%v", exit, err)
				}
			} else if exit != 0 || err != nil {
				t.Fatalf("Run() = %d, %v", exit, err)
			}
			want := int32(1)
			if scenario.advertised {
				want = 0
			}
			if got := listCalls.Load(); got != want {
				t.Fatalf("skills list requests = %d, want %d", got, want)
			}
		})
	}
}

// A slow server must not serialize unrelated local auth readers when the
// launch is only retrieving an already acknowledged account generation.
func TestCanonicalBootstrapReleasesAuthLockBeforeHTTP(t *testing.T) {
	for _, scenario := range []struct {
		name          string
		changedNative bool
		unbound       bool
	}{
		{name: "canonical"},
		{name: "changed_native", changedNative: true},
		{name: "unknown_account", unbound: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			path, canonical := sessionFixture(t)
			before, err := claude.ReadAuthSnapshot(false)
			if err != nil {
				t.Fatal(err)
			}
			digest := strings.Repeat("b", 64)
			if applied, err := claude.WriteVerifiedServerAuthIfCurrentWithDigest(canonical, digest, "verified", before.Generation); err != nil || !applied {
				t.Fatalf("seed verified canonical: applied=%v err=%v", applied, err)
			}
			if scenario.changedNative {
				if err := os.WriteFile(path, sessionPayload("different-login", time.Now()), 0600); err != nil {
					t.Fatal(err)
				}
			}
			wantCandidate := scenario.changedNative || scenario.unbound
			client := sessionClient(t, func(w http.ResponseWriter, r *http.Request) {
				var req orchestrator.BundleRequest
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
					t.Error(err)
				}
				if offered := len(req.AuthCandidate) != 0; offered != wantCandidate {
					t.Errorf("candidate offered=%v want=%v", offered, wantCandidate)
				}
				if !wantCandidate && req.AuthDigest != digest {
					t.Errorf("retrieve digest=%q want=%q", req.AuthDigest, digest)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
				defer cancel()
				_, err := claude.ReadAuthSnapshotContext(ctx, false)
				if wantCandidate && !errors.Is(err, context.DeadlineExceeded) {
					t.Errorf("candidate did not retain its writer transaction: %v", err)
				} else if !wantCandidate && err != nil {
					t.Errorf("canonical retrieve held the local writer lock over HTTP: %v", err)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"auth":{"status":"valid","verification_state":"verified"}}`)
			})
			if !scenario.unbound {
				client.Pool = &accountpool.Context{Engine: "claude", AccountID: 7}
			}
			_, err, _, _, _, _, _ = bootstrap(context.Background(), client, slog.New(slog.DiscardHandler), false, path, true)
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCanonicalBootstrapKeepsGenerationAndLogoutGuards(t *testing.T) {
	for _, scenario := range []string{"newer_canonical", "native_login_race", "logout_race", "missing_server_head"} {
		t.Run(scenario, func(t *testing.T) {
			path, canonical := sessionFixture(t)
			before, _ := claude.ReadAuthSnapshot(false)
			if applied, err := claude.WriteVerifiedServerAuthIfCurrentWithDigest(canonical, strings.Repeat("b", 64), "verified", before.Generation); err != nil || !applied {
				t.Fatalf("seed canonical: applied=%v err=%v", applied, err)
			}
			canonicalSnapshot, _ := claude.ReadAuthSnapshot(false)
			newer := sessionPayload("new-canonical", time.Now().Add(-time.Minute))
			client := sessionClient(t, func(w http.ResponseWriter, r *http.Request) {
				var req orchestrator.BundleRequest
				_ = json.NewDecoder(r.Body).Decode(&req)
				if len(req.AuthCandidate) != 0 {
					t.Error("canonical retrieve resubmitted credentials")
				}
				switch scenario {
				case "native_login_race":
					if err := os.WriteFile(path, sessionPayload("native-login", time.Now()), 0600); err != nil {
						t.Error(err)
					}
				case "logout_race":
					if marked, err := claude.RecordExplicitLogout(canonicalSnapshot.Generation); err != nil || !marked {
						t.Errorf("overlapping logout: marked=%v err=%v", marked, err)
					}
				}
				w.Header().Set("Content-Type", "application/json")
				if scenario == "missing_server_head" {
					_, _ = io.WriteString(w, `{"auth":{"status":"missing","action":"store"}}`)
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"auth": map[string]any{"status": "outdated", "verification_state": "verified", "auth": newer, "canonical_digest": strings.Repeat("c", 64), "canonical_last_refresh": time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)}})
			})
			client.Pool = &accountpool.Context{Engine: "claude", AccountID: 7}
			resp, err, _, _, _, _, _ := bootstrap(context.Background(), client, slog.New(slog.DiscardHandler), false, path, true)
			if err != nil {
				t.Fatal(err)
			}
			after, readErr := claude.ReadAuthSnapshot(false)
			switch scenario {
			case "newer_canonical":
				if readErr != nil || !strings.Contains(string(after.Raw), "new-canonical") {
					t.Fatalf("new verified head not applied: %v", readErr)
				}
			case "native_login_race":
				if readErr != nil || !strings.Contains(string(after.Raw), "native-login") {
					t.Fatalf("concurrent native login overwritten: %v", readErr)
				}
			case "logout_race":
				if !claude.HasLogoutIntent() || claude.HasUsableAuth() {
					t.Fatal("retrieve resurrected explicitly logged-out credentials")
				}
			case "missing_server_head":
				if resp.Status != "missing" || readErr != nil || after.Generation != canonicalSnapshot.Generation {
					t.Fatalf("missing head lost local upload fallback: status=%q err=%v", resp.Status, readErr)
				}
			}
		})
	}
}

func TestAuthOnlyBootstrapOmitsManagedContentDigests(t *testing.T) {
	path, _ := sessionFixture(t)
	for _, file := range []string{agentsPath(), settingsPath()} {
		if err := os.WriteFile(file, []byte("managed content"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	client := sessionClient(t, func(w http.ResponseWriter, r *http.Request) {
		var req orchestrator.BundleRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		if req.IncludeContent == nil || *req.IncludeContent || req.Agents != "" || req.Config != "" || len(req.Artifacts) != 0 {
			t.Error("auth-only bootstrap included managed-content metadata")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"auth":{"status":"valid","verification_state":"verified"}}`)
	})
	_, err, _, _, _, _, _ := bootstrap(communicator.WithCachedContent(context.Background()), client, slog.New(slog.DiscardHandler), false, path, true)
	if err != nil {
		t.Fatal(err)
	}
}

func TestCanonicalBootstrapArbitratesFailedServerHead(t *testing.T) {
	for _, sameCredentials := range []bool{false, true} {
		t.Run(fmt.Sprintf("same_credentials_%v", sameCredentials), func(t *testing.T) {
			path, canonical := sessionFixture(t)
			before, _ := claude.ReadAuthSnapshot(false)
			if applied, err := claude.WriteVerifiedServerAuthIfCurrentWithDigest(canonical, strings.Repeat("b", 64), "verified", before.Generation); err != nil || !applied {
				t.Fatalf("seed canonical: applied=%v err=%v", applied, err)
			}
			calls := 0
			client := sessionClient(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				var req orchestrator.BundleRequest
				_ = json.NewDecoder(r.Body).Decode(&req)
				if got := len(req.AuthCandidate) != 0; got != (calls == 2) {
					t.Errorf("request %d candidate=%v", calls, got)
				}
				auth := map[string]any{"status": "outdated", "verification_state": "failed"}
				if calls == 2 {
					auth["candidate_matches_failed_canonical"] = sameCredentials
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"auth": auth})
			})
			client.Pool = &accountpool.Context{Engine: "claude", AccountID: 7}
			resp, err, _, _, _, _, _ := bootstrap(context.Background(), client, slog.New(slog.DiscardHandler), false, path, true)
			if err != nil || calls != 2 {
				t.Fatalf("failed-head arbitration: requests=%d err=%v", calls, err)
			}
			decision := decideAuth(resp, nil, path, true)
			if decision.Allowed == sameCredentials {
				t.Fatalf("failed head identity gate allowed=%v same=%v", decision.Allowed, sameCredentials)
			}
		})
	}
}

func TestCanonicalBootstrapFailedHeadSurvivesArbitrationFailure(t *testing.T) {
	for _, scenario := range []string{"http_503", "timeout", "missing_auth", "offline_auth"} {
		t.Run(scenario, func(t *testing.T) {
			path, canonical := sessionFixture(t)
			before, _ := claude.ReadAuthSnapshot(false)
			if applied, err := claude.WriteVerifiedServerAuthIfCurrentWithDigest(canonical, strings.Repeat("b", 64), "verified", before.Generation); err != nil || !applied {
				t.Fatalf("seed canonical: applied=%v err=%v", applied, err)
			}
			var calls atomic.Int32
			client := sessionClient(t, func(w http.ResponseWriter, r *http.Request) {
				call := calls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				if call == 1 {
					_, _ = io.WriteString(w, `{"auth":{"status":"outdated","verification_state":"failed","canonical_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}`)
					return
				}
				var req orchestrator.BundleRequest
				_ = json.NewDecoder(r.Body).Decode(&req)
				if len(req.AuthCandidate) == 0 {
					t.Error("retry omitted serialized candidate")
				}
				switch scenario {
				case "http_503":
					w.WriteHeader(http.StatusServiceUnavailable)
					_, _ = io.WriteString(w, `{"code":"runner_unreachable"}`)
				case "timeout":
					<-r.Context().Done()
				case "missing_auth":
					_, _ = io.WriteString(w, `{}`)
				case "offline_auth":
					_, _ = io.WriteString(w, `{"auth":{"status":"offline"}}`)
				}
			})
			client.Pool = &accountpool.Context{Engine: "claude", AccountID: 7}
			deadline := 5 * time.Second
			if scenario == "timeout" {
				deadline = 150 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(context.Background(), deadline)
			defer cancel()
			resp, err, _, _, _, _, _ := bootstrap(ctx, client, slog.New(slog.DiscardHandler), false, path, true)
			if calls.Load() < 2 || resp == nil || resp.VerificationState != "failed" {
				t.Fatalf("lost authoritative failed head: requests=%d response=%+v err=%v", calls.Load(), resp, err)
			}
			decision := decideAuth(resp, err, path, true)
			if decision.Allowed || decision.LocalUsable {
				t.Fatalf("failed arbitration allowed rejected local head: %+v err=%v", decision, err)
			}
		})
	}
}

func TestCanonicalBootstrapRetryPreservesTrustLossCleanup(t *testing.T) {
	for _, scenario := range []struct {
		name           string
		status         int
		body           string
		wantStrip      bool
		corruptRouting bool
	}{
		{name: "invalid_api_key", status: 403, body: `{"code":"invalid_api_key"}`, wantStrip: true},
		{name: "host_deleted", status: 403, body: `{"code":"host_deleted"}`, wantStrip: true},
		{name: "host_disabled", status: 403, body: `{"code":"host_disabled"}`, wantStrip: true},
		{name: "insecure_denied", status: 403, body: `{"code":"insecure_denied"}`, wantStrip: true},
		{name: "host_engine_removed", status: 403, body: `{"code":"engine_disabled","scope":"host"}`, wantStrip: true},
		{name: "fleet_engine_suspended", status: 403, body: `{"code":"engine_disabled","scope":"fleet"}`},
		{name: "ip_mismatch", status: 403, body: `{"code":"ip_mismatch"}`},
		{name: "approval_pending", status: 423, body: `{"code":"insecure_pending"}`},
		{name: "validation_failed", status: 422, body: `{"code":"validation_failed"}`},
		{name: "no_legacy_fallback", status: 404, body: `{"code":"not_found"}`},
		{name: "cleanup_failure", status: 403, body: `{"code":"invalid_api_key"}`, corruptRouting: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			path, canonical := sessionFixture(t)
			before, _ := claude.ReadAuthSnapshot(false)
			if applied, err := claude.WriteVerifiedServerAuthIfCurrentWithDigest(canonical, strings.Repeat("b", 64), "verified", before.Generation); err != nil || !applied {
				t.Fatalf("seed canonical: applied=%v err=%v", applied, err)
			}
			nativeHome := filepath.Dir(path)
			memoryDir := filepath.Join(os.Getenv("HOME"), "selected-memory")
			memoryPath := filepath.Join(memoryDir, "MEMORY.md")
			if err := os.MkdirAll(memoryDir, 0700); err != nil {
				t.Fatal(err)
			}
			const notes = "operator notes stay here\n"
			if err := os.WriteFile(memoryPath, []byte(notes), 0600); err != nil {
				t.Fatal(err)
			}
			settings, _ := json.Marshal(map[string]string{"autoMemoryDirectory": memoryDir})
			if err := os.WriteFile(filepath.Join(nativeHome, "settings.json"), settings, 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("CLAUDE_CONFIG_DIR", "")
			t.Setenv("CLAUDE_CODE_MANAGED_SETTINGS_PATH", filepath.Join(os.Getenv("HOME"), "absent-policy.json"))
			if _, err := memoryrouting.Apply("claude", nativeHome, &memoryrouting.Bundle{Enabled: true, Content: "Use shared_memory_search over MCP"}, nil); err != nil {
				t.Fatal(err)
			}
			if raw, err := os.ReadFile(memoryPath); err != nil || !strings.Contains(string(raw), memoryrouting.Start) {
				t.Fatalf("managed routing fixture absent: %v", err)
			}
			if scenario.corruptRouting {
				if err := os.WriteFile(memoryPath, []byte(memoryrouting.Start+"\nunpaired marker\n"+notes), 0600); err != nil {
					t.Fatal(err)
				}
			}
			var calls atomic.Int32
			client := sessionClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path != "/sync/bootstrap" {
					t.Errorf("retry entered legacy fallback: %s", r.URL.Path)
				}
				if calls.Add(1) == 1 {
					_, _ = io.WriteString(w, `{"auth":{"status":"outdated","verification_state":"failed"}}`)
					return
				}
				w.WriteHeader(scenario.status)
				_, _ = io.WriteString(w, scenario.body)
			})
			client.Pool = &accountpool.Context{Engine: "claude", AccountID: 7}
			resp, err, _, _, configSync, _, _ := bootstrap(context.Background(), client, slog.New(slog.DiscardHandler), false, path, true)
			if calls.Load() != 2 || err == nil || resp == nil || resp.VerificationState != "failed" {
				t.Fatalf("retry lost failed verdict: requests=%d resp=%+v err=%v", calls.Load(), resp, err)
			}
			if decision := decideAuth(resp, err, path, true); decision.Allowed || decision.LocalUsable {
				t.Fatalf("retry error allowed failed credentials: %+v", decision)
			}
			raw, readErr := os.ReadFile(memoryPath)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if scenario.wantStrip && string(raw) != notes {
				t.Fatalf("trust loss did not surgically strip managed routing: %q", raw)
			}
			if !scenario.wantStrip && !strings.Contains(string(raw), memoryrouting.Start) {
				t.Fatal("non-revoking error stripped managed routing")
			}
			if scenario.corruptRouting && (configSync.Err == nil || !strings.Contains(err.Error(), "managed memory cleanup incomplete")) {
				t.Fatalf("cleanup failure hidden: config=%+v err=%v", configSync, err)
			}
		})
	}
}
