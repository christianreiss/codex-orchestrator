package lifecycle

import (
	"context"
	"crypto/sha256"
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

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/summary"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/ui"
)

func TestPresentedErrorAndPortableLifecycleText(t *testing.T) {
	err := errors.New("denied → next\n\x1b[31m")
	marked := markPresented(err, Options{SkipBoot: false})
	if !ErrorWasPresented(marked) || ErrorWasPresented(markPresented(err, Options{SkipBoot: true})) {
		t.Fatal("presented-error marker does not match boot visibility")
	}
	if got := safeLifecycleText(err.Error(), true); strings.ContainsAny(got, "→\n\r\x1b") {
		t.Fatalf("portable lifecycle text leaked controls/Unicode: %q", got)
	}
}

func TestFooterCapsKeepsMinimalRunsCompact(t *testing.T) {
	caps := ui.Caps{IsTTY: true, Palette: ui.Palette{Reset: "ansi"}}
	got := footerCaps(caps, true)
	if got.IsTTY || got.Palette.Reset != "" {
		t.Fatalf("minimal footer retained rich capabilities: %+v", got)
	}
	if got := footerCaps(caps, false); !got.IsTTY || got.Palette.Reset != "ansi" {
		t.Fatalf("normal footer lost rich capabilities: %+v", got)
	}
}

func TestConcurrentNoteExplainsManagedSyncPause(t *testing.T) {
	got := concurrentNote(true, orchestrator.AuthDecision{LocalUsable: true})
	if !strings.Contains(got, "Managed content sync paused") || !strings.Contains(got, "auth freshness remains active") || strings.Contains(strings.ToLower(got), "read-only") {
		t.Fatalf("concurrent note = %q", got)
	}
}

func TestUpdateCapsHonorsMinimal(t *testing.T) {
	t.Setenv("TERM", "xterm-256color")
	t.Setenv("LANG", "C.UTF-8")
	got := updateCaps(nil, true)
	if got.IsTTY || !got.Dumb || got.UTF8 || got.Palette.Reset != "" {
		t.Fatalf("minimal update caps = %+v", got)
	}
}

func TestBuildSessionCountsMirrorsFleetAndLocalValues(t *testing.T) {
	if got := buildSessionCounts(nil); got != nil {
		t.Fatalf("nil fleet sessions = %+v", got)
	}
	got := buildSessionCounts(&orchestrator.FleetSessions{Now: 7, Today: 21, Month: 314})
	if got == nil || got.LocalNow < 1 || got.FleetNow != 7 || got.Today != 21 || got.Month != 314 {
		t.Fatalf("session counts = %+v", got)
	}
}

func TestApplyBundleClaudeSkillsPreservesAbsentFieldCompatibility(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	absent := applyBundleClaudeSkills(nil, logger)
	if absent.Checked || absent.Updated || absent.Err != nil {
		t.Fatalf("absent claude_skills produced a resource outcome: %+v", absent)
	}

	empty := applyBundleClaudeSkills([]orchestrator.CollectionItem{}, logger)
	if !empty.Checked || empty.Updated || empty.Err != nil {
		t.Fatalf("explicit empty claude_skills was not a successful check: %+v", empty)
	}
}

func TestCombineOptionalResourceSyncKeepsLegacyProbeAndPropagatesFailure(t *testing.T) {
	base := summary.ResourceSync{Checked: true, Updated: true}
	if got := combineOptionalResourceSync(base, summary.ResourceSync{}); !got.Checked || !got.Updated || got.Err != nil {
		t.Fatalf("absent optional state changed base probe: %+v", got)
	}

	wantErr := errors.New("native skill write failed")
	got := combineOptionalResourceSync(base, summary.ResourceSync{Checked: true, Err: wantErr})
	if !got.Checked || !got.Updated || !errors.Is(got.Err, wantErr) {
		t.Fatalf("native skill failure was not propagated: %+v", got)
	}
}

func TestBootstrapRoutesClaudeSkillFailureAwayFromConfigStatus(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sync/bootstrap" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"status":"success","auth":{"status":"valid"},"claude_skills":[{"slug":"reviewer","sha256":"sha-reviewer","status":"updated"}]}}`))
	}))
	defer server.Close()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	_, bootstrapErr, _, _, configSync, nativeSkillsSync, _ := bootstrap(
		context.Background(), client, logger, false, "",
	)
	if bootstrapErr != nil {
		t.Fatalf("bootstrap returned transport error: %v", bootstrapErr)
	}
	if configSync.Err != nil {
		t.Fatalf("native skill failure leaked into config status: %v", configSync.Err)
	}
	if !nativeSkillsSync.Checked || nativeSkillsSync.Err == nil {
		t.Fatalf("native skill failure missing from skills status: %+v", nativeSkillsSync)
	}
}

func TestBundleUnsafeRunnerWritebackFailsClosedWithLocalAuth(t *testing.T) {
	for _, concurrent := range []bool{false, true} {
		t.Run(fmt.Sprintf("concurrent=%t", concurrent), func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			authPath := filepath.Join(home, ".claude", ".credentials.json")
			if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(authPath, []byte(`{"last_refresh":"2026-07-17T12:00:00Z","claudeAiOauth":{"accessToken":"pre-refresh-local"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"status":"error","code":"runner_updated_auth_invalid","message":"runner refresh saved pending retry"}`))
			}))
			defer server.Close()
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
			if err != nil {
				t.Fatal(err)
			}
			resp, authErr, _, _, _, _, _ := bootstrap(context.Background(), client, logger, concurrent, authPath)
			if !orchestrator.IsUnsafeRunnerUpdatedAuthError(authErr) {
				t.Fatalf("bootstrap error = %v", authErr)
			}
			dec := decideAuth(resp, authErr, authPath, true)
			if dec.Allowed || dec.LocalUsable || !strings.Contains(dec.Reason, "superseded") {
				t.Fatalf("unsafe bundle decision = %+v", dec)
			}
			raw, err := os.ReadFile(authPath)
			if err != nil || !strings.Contains(string(raw), "pre-refresh-local") {
				t.Fatalf("bundle error changed local auth: %q, %v", raw, err)
			}
		})
	}
}

func TestBootstrapUsesSharedServerAuthReplacementGate(t *testing.T) {
	for _, tc := range []struct {
		name       string
		verify     string
		definitive bool
		wantToken  string
		wantSynced bool
	}{
		{name: "older canonical preserves newer local", verify: "verified", wantToken: "local"},
		{name: "definitive rejection heals from verified canonical", verify: "verified", definitive: true, wantToken: "canonical", wantSynced: true},
		{name: "failed canonical is never materialized", verify: "failed", definitive: true, wantToken: "local"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			authPath := filepath.Join(home, ".claude", ".credentials.json")
			if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(authPath, []byte(`{"last_refresh":"2026-07-16T12:00:00Z","claudeAiOauth":{"accessToken":"local"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			preflight, err := claude.ReadAuthForRetrieveSnapshot()
			if err != nil {
				t.Fatal(err)
			}
			if !tc.definitive && tc.verify == "verified" && claude.ServerAuthMayReplace(preflight, json.RawMessage(`{"last_refresh":"2026-07-16T11:00:00Z","claudeAiOauth":{"accessToken":"canonical"}}`), "2026-07-16T11:00:00Z", tc.verify, false) {
				t.Fatalf("preflight gate allowed older canonical: %+v", preflight)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = fmt.Fprintf(w, `{"status":"success","data":{"status":"success","auth":{"status":"outdated","verification_state":%q,"candidate_rejected_definitive":%t,"canonical_last_refresh":"2026-07-16T11:00:00Z","auth":{"last_refresh":"2026-07-16T11:00:00Z","claudeAiOauth":{"accessToken":"canonical"}}}}}`, tc.verify, tc.definitive)
			}))
			defer server.Close()
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
			if err != nil {
				t.Fatal(err)
			}
			_, bootstrapErr, synced, _, _, _, _ := bootstrap(context.Background(), client, logger, false, authPath)
			if bootstrapErr != nil {
				t.Fatal(bootstrapErr)
			}
			if synced != tc.wantSynced {
				t.Fatalf("authSynced=%v want=%v", synced, tc.wantSynced)
			}
			raw, err := os.ReadFile(authPath)
			if err != nil || !strings.Contains(string(raw), `"accessToken":"`+tc.wantToken+`"`) {
				t.Fatalf("native auth=%q err=%v want token %q", raw, err, tc.wantToken)
			}
		})
	}
}

func TestBootstrapRepairsStructurallyInvalidNativeJSON(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	authPath := filepath.Join(home, ".claude", ".credentials.json")
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(authPath, []byte(`{broken-json`), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"auth":{"status":"outdated","verification_state":"verified","canonical_last_refresh":"2026-07-16T11:00:00Z","auth":{"last_refresh":"2026-07-16T11:00:00Z","claudeAiOauth":{"accessToken":"healed"}}}}}`))
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	_, bootstrapErr, synced, _, _, _, _ := bootstrap(context.Background(), client, logger, false, authPath)
	if bootstrapErr != nil || !synced {
		t.Fatalf("invalid native repair synced=%v err=%v", synced, bootstrapErr)
	}
	raw, err := os.ReadFile(authPath)
	if err != nil || !strings.Contains(string(raw), `"accessToken":"healed"`) {
		t.Fatalf("invalid native was not healed: %q err=%v", raw, err)
	}
}

func TestBootstrapConcurrentRepairsUnusableAuthDespiteMatchingGenerationDigest(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	authPath := filepath.Join(home, ".claude", ".credentials.json")
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	writeUnusableAuthWithMatchingSidecar := func(stamp string) {
		t.Helper()
		raw := []byte(`{"claudeAiOauth":{"accessToken":"","refreshToken":""}}`)
		if err := os.WriteFile(authPath, raw, 0o600); err != nil {
			t.Fatal(err)
		}
		stateDir := filepath.Join(home, ".clx", "auth")
		if err := os.MkdirAll(stateDir, 0o700); err != nil {
			t.Fatal(err)
		}
		digest := fmt.Sprintf("%x", sha256.Sum256(raw))
		state := fmt.Sprintf(`{"version":1,"digest":%q,"last_refresh":%q,"canonical_digest":%q}`, digest, stamp, strings.Repeat("a", 64))
		if err := os.WriteFile(filepath.Join(stateDir, "generation.json"), []byte(state), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeUnusableAuthWithMatchingSidecar("2026-07-21T12:00:00Z")
	if _, err := claude.AuthPath(); err != nil {
		t.Fatal(err)
	}
	seenEmptyDigest := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode bundle request: %v", err)
		}
		digest, sentDigest := request["auth_digest"]
		seenEmptyDigest = !sentDigest || string(digest) == `""`
		if _, ok := request["auth_candidate"]; ok {
			t.Error("unusable auth was sent as a candidate")
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/auth" {
			_, _ = w.Write([]byte(`{"status":"outdated","verification_state":"verified","canonical_last_refresh":"2026-07-21T12:01:00Z","auth":{"last_refresh":"2026-07-21T12:01:00Z","claudeAiOauth":{"accessToken":"healed","refreshToken":"fresh"}}}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"success","data":{"auth":{"status":"outdated","verification_state":"verified","canonical_last_refresh":"2026-07-21T12:01:00Z","auth":{"last_refresh":"2026-07-21T12:01:00Z","claudeAiOauth":{"accessToken":"healed","refreshToken":"fresh"}}}}}`))
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	resp, bootstrapErr, synced, _, _, _, _ := bootstrap(context.Background(), client, logger, true, authPath)
	if bootstrapErr != nil || !synced || resp == nil {
		t.Fatalf("concurrent unusable auth repair = resp=%+v synced=%v err=%v", resp, synced, bootstrapErr)
	}
	if !seenEmptyDigest {
		t.Fatal("unusable auth advertised a canonical digest instead of requesting repair")
	}
	if !claude.IsValidLocalAuth(authPath) {
		t.Fatal("concurrent canonical repair did not leave usable Claude credentials")
	}
	writeUnusableAuthWithMatchingSidecar("2026-07-21T12:02:00Z")
	seenEmptyDigest = false
	resp, legacyErr, synced := syncAuthLegacy(context.Background(), client, logger, true)
	if legacyErr != nil || !synced || resp == nil {
		t.Fatalf("concurrent legacy unusable auth repair = resp=%+v synced=%v err=%v", resp, synced, legacyErr)
	}
	if !seenEmptyDigest || !claude.IsValidLocalAuth(authPath) {
		t.Fatal("legacy concurrent repair did not request and restore usable Claude credentials")
	}
}

func TestBundleAndLegacyMaterializeRequiredCanonicalAlongsideActiveChild(t *testing.T) {
	for _, mode := range []string{"bundle", "legacy"} {
		t.Run(mode, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T08:00:00Z","claudeAiOauth":{"accessToken":"client-older"}}`)); err != nil {
				t.Fatal(err)
			}
			ready := filepath.Join(home, "ready")
			release := filepath.Join(home, "release")
			t.Setenv("CLX_TEST_READY", ready)
			t.Setenv("CLX_TEST_RELEASE", release)
			bin := filepath.Join(t.TempDir(), "claude")
			script := `#!/bin/sh
: > "$CLX_TEST_READY"
while [ ! -e "$CLX_TEST_RELEASE" ]; do sleep 0.01; done
`
			if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
				t.Fatal(err)
			}
			t.Setenv("CLX_CLAUDE_BIN", bin)
			childDone := make(chan error, 1)
			go func() {
				_, err := claude.Run(context.Background(), &config.Config{}, nil)
				childDone <- err
			}()
			deadline := time.Now().Add(3 * time.Second)
			for {
				if _, err := os.Stat(ready); err == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("peer Claude child did not start")
				}
				time.Sleep(10 * time.Millisecond)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				canonical := `{"status":"outdated","verification_state":"verified","canonical_last_refresh":"2026-07-17T09:00:00Z","auth":{"last_refresh":"2026-07-17T09:00:00Z","claudeAiOauth":{"accessToken":"server-newer"}}}`
				if r.URL.Path == "/sync/bootstrap" {
					_, _ = w.Write([]byte(`{"status":"success","data":{"auth":` + canonical + `}}`))
					return
				}
				_, _ = w.Write([]byte(canonical))
			}))
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
			if err != nil {
				t.Fatal(err)
			}
			if mode == "bundle" {
				_, err, _, _, _, _, _ = bootstrap(context.Background(), client, logger, false, filepath.Join(home, ".claude", ".credentials.json"))
			} else {
				_, err, _ = syncAuthLegacy(context.Background(), client, logger, false)
			}
			if err != nil {
				t.Fatalf("%s active-child materialization error=%v", mode, err)
			}
			raw, readErr := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
			if readErr != nil || !strings.Contains(string(raw), "server-newer") {
				t.Fatalf("%s active child changed client auth: %q err=%v", mode, raw, readErr)
			}
			server.Close()
			if err := os.WriteFile(release, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := <-childDone; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestBundleAndLegacyRepairExactDefinitivelyRejectedLocalUnderActiveChild(t *testing.T) {
	for _, mode := range []string{"bundle", "legacy"} {
		t.Run(mode, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T12:00:00Z","claudeAiOauth":{"accessToken":"rejected-local"}}`)); err != nil {
				t.Fatal(err)
			}
			authPath, err := claude.AuthPath()
			if err != nil {
				t.Fatal(err)
			}
			ready := filepath.Join(home, "ready")
			release := filepath.Join(home, "release")
			t.Setenv("CLX_TEST_READY", ready)
			t.Setenv("CLX_TEST_RELEASE", release)
			bin := filepath.Join(t.TempDir(), "claude")
			writeTestScript(t, bin, `#!/bin/sh
: > "$CLX_TEST_READY"
while [ ! -e "$CLX_TEST_RELEASE" ]; do sleep 0.01; done
`)
			t.Setenv("CLX_CLAUDE_BIN", bin)
			t.Cleanup(func() { _ = os.WriteFile(release, nil, 0o600) })
			childDone := make(chan error, 1)
			go func() {
				_, err := claude.Run(context.Background(), &config.Config{}, nil)
				childDone <- err
			}()
			deadline := time.Now().Add(3 * time.Second)
			for {
				if _, err := os.Stat(ready); err == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("peer Claude child did not start")
				}
				time.Sleep(10 * time.Millisecond)
			}
			canonical := `{"status":"outdated","verification_state":"verified","candidate_rejected_definitive":true,"canonical_last_refresh":"2026-07-17T11:00:00Z","auth":{"last_refresh":"2026-07-17T11:00:00Z","claudeAiOauth":{"accessToken":"canonical-repair"}}}`
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/sync/bootstrap" {
					_, _ = w.Write([]byte(`{"status":"success","data":{"auth":` + canonical + `}}`))
					return
				}
				_, _ = w.Write([]byte(canonical))
			}))
			defer server.Close()
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
			if err != nil {
				t.Fatal(err)
			}
			if mode == "bundle" {
				_, err, _, _, _, _, _ = bootstrap(context.Background(), client, logger, false, authPath)
			} else {
				_, err, _ = syncAuthLegacy(context.Background(), client, logger, false)
			}
			if err != nil {
				t.Fatalf("%s exact rejected generation error=%v", mode, err)
			}
			raw, readErr := os.ReadFile(authPath)
			if readErr != nil || !strings.Contains(string(raw), "canonical-repair") {
				t.Fatalf("active child auth changed: %q err=%v", raw, readErr)
			}
			if err := os.WriteFile(release, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := <-childDone; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestLegacyTwoWayAuthArbitration(t *testing.T) {
	for _, tc := range []struct {
		name          string
		storeStatus   int
		storeBody     string
		wantToken     string
		wantErr       bool
		wantRespValid bool
	}{
		{name: "accepted local converges", storeStatus: http.StatusOK, storeBody: `{"status":"valid","verification_state":"verified"}`, wantToken: "local", wantRespValid: true},
		{name: "transient preserves local", storeStatus: http.StatusServiceUnavailable, storeBody: `{"status":"error","code":"runner_unreachable","message":"later"}`, wantToken: "local"},
		{name: "validation 422 heals verified canonical", storeStatus: http.StatusUnprocessableEntity, storeBody: `{"status":"error","code":"validation_failed","message":"bad candidate"}`, wantToken: "canonical"},
		{name: "security 403 preserves local", storeStatus: http.StatusForbidden, storeBody: `{"status":"error","code":"engine_disabled","message":"disabled"}`, wantToken: "local"},
		{name: "unsafe rotated auth fails closed", storeStatus: http.StatusServiceUnavailable, storeBody: `{"status":"error","code":"runner_updated_auth_invalid","message":"bad writeback"}`, wantToken: "local", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			authPath := filepath.Join(home, ".claude", ".credentials.json")
			if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(authPath, []byte(`{"last_refresh":"2026-07-16T12:00:00Z","claudeAiOauth":{"accessToken":"local"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Command string `json:"command"`
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				w.Header().Set("Content-Type", "application/json")
				if body.Command == "store" {
					w.WriteHeader(tc.storeStatus)
					_, _ = w.Write([]byte(tc.storeBody))
					return
				}
				_, _ = w.Write([]byte(`{"status":"outdated","verification_state":"verified","canonical_last_refresh":"2026-07-16T11:00:00Z","auth":{"last_refresh":"2026-07-16T11:00:00Z","claudeAiOauth":{"accessToken":"canonical"}}}`))
			}))
			defer server.Close()
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
			if err != nil {
				t.Fatal(err)
			}
			resp, syncErr, _ := syncAuthLegacy(context.Background(), client, logger, false)
			if (syncErr != nil) != tc.wantErr {
				t.Fatalf("sync error=%v wantErr=%v", syncErr, tc.wantErr)
			}
			if tc.wantRespValid && (resp == nil || resp.Status != "valid") {
				t.Fatalf("accepted arbitration response=%+v", resp)
			}
			raw, err := os.ReadFile(authPath)
			if err != nil || !strings.Contains(string(raw), `"accessToken":"`+tc.wantToken+`"`) {
				t.Fatalf("legacy arbitration auth=%q err=%v want=%q", raw, err, tc.wantToken)
			}
		})
	}
}

func TestRunRejectsFQDNMismatchBeforeNetworkAndBoot(t *testing.T) {
	t.Setenv("CLAUDE_ALLOW_FQDN_MISMATCH", "")
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"valid"}`))
	}))
	defer server.Close()

	cfg := &config.Config{
		Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-key"},
		Host: config.Host{
			FQDN: "definitely-not-this-host.example.invalid\x1b[31m\nforged",
		},
	}
	var (
		exitCode int
		runErr   error
	)
	exitCode, runErr = Run(context.Background(), Options{
		Config: cfg,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})

	if exitCode != 1 || runErr == nil {
		t.Fatalf("Run mismatch = (%d, %v), want (1, error)", exitCode, runErr)
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("FQDN guard ran after network activity: %d requests", got)
	}
	portable := safeLifecycleText(runErr.Error(), true)
	if strings.Contains(strings.ToLower(portable), "ready") {
		t.Fatalf("mismatch returned a green-ready result: %q", portable)
	}
	if !strings.Contains(portable, "CLAUDE_ALLOW_FQDN_MISMATCH=1") {
		t.Fatalf("mismatch error is not actionable: %q", portable)
	}
	if strings.ContainsAny(portable, "\r\n\x1b") {
		t.Fatalf("mismatch error contains unsanitized terminal controls: %q", portable)
	}
}

func TestCurrentWrapperVersionPrefersRunningVersion(t *testing.T) {
	cfg := &config.Config{Wrapper: config.Wrapper{Version: "0.6.18"}}
	got := currentWrapperVersion(Options{WrapperVersion: "0.6.23"}, cfg)
	if got != "0.6.23" {
		t.Fatalf("currentWrapperVersion() = %q, want running version", got)
	}
}

func TestCurrentWrapperVersionFallsBackToConfig(t *testing.T) {
	cfg := &config.Config{Wrapper: config.Wrapper{Version: "0.6.18"}}
	got := currentWrapperVersion(Options{}, cfg)
	if got != "0.6.18" {
		t.Fatalf("currentWrapperVersion() = %q, want config version", got)
	}
}

func TestMaybeEnsureClaudeSkipsMatchingTargetWithoutProgressLine(t *testing.T) {
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)

	claudePath := filepath.Join(bin, "claude")
	npmPath := filepath.Join(bin, "npm")
	marker := filepath.Join(dir, "npm-called")
	writeTestScript(t, claudePath, `#!/bin/sh
echo "2.1.168"
`)
	writeTestScript(t, npmPath, `#!/bin/sh
echo called > "`+marker+`"
exit 42
`)
	t.Setenv("CLX_CLAUDE_BIN", claudePath)
	t.Setenv("PATH", bin)

	target := "2.1.168"
	auth := &orchestrator.AuthRetrieveResponse{
		Versions: &orchestrator.VersionSummary{
			AutoUpdateEnabled:         true,
			ClientVersion:             &target,
			ClientVersionEnforceExact: true,
		},
	}

	stderr := captureStderr(t, func() {
		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		if got := maybeEnsureClaude(context.Background(), nil, auth, false, false, logger); got != "" {
			t.Fatalf("maybeEnsureClaude() = %q, want no update", got)
		}
	})
	if strings.Contains(stderr, "installing claude CLI") || strings.Contains(stderr, "claude CLI updated") {
		t.Fatalf("unexpected update progress on stderr: %q", stderr)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("npm was called for an already matching target; stat err=%v", err)
	}
}

func TestWrapperAutoUpdateFinalizesSoleSessionBeforeFailedReexec(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_WRAPPER_RESTARTED", "")
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"temporary"}}`)); err != nil {
		t.Fatal(err)
	}
	session, err := claude.StartAuthSession(true)
	if err != nil {
		t.Fatal(err)
	}
	oldUpdate, oldExec := wrapperSelfUpdate, wrapperReExec
	t.Cleanup(func() {
		wrapperSelfUpdate = oldUpdate
		wrapperReExec = oldExec
	})
	wrapperSelfUpdate = func(context.Context, *config.Config, string, string, string, *slog.Logger) (string, error) {
		return "/tmp/clx-updated", nil
	}
	execErr := errors.New("exec replacement failed")
	execCalled := false
	wrapperReExec = func(exe string, _ []string) error {
		execCalled = true
		if exe != "/tmp/clx-updated" {
			t.Fatalf("reexec path=%q", exe)
		}
		if claude.HasUsableAuth() {
			t.Fatal("reexec attempted before sole insecure session purged")
		}
		return execErr
	}
	target, url, sha := "0.6.46", "https://updates.invalid/clx", strings.Repeat("a", 64)
	auth := &orchestrator.AuthRetrieveResponse{Versions: &orchestrator.VersionSummary{
		AutoUpdateEnabled: true,
		WrapperVersion:    &target,
		WrapperURL:        &url,
		WrapperSHA256:     &sha,
	}}
	err = maybeEnsureWrapper(context.Background(), &config.Config{}, auth, "0.6.45", false, true, slog.New(slog.NewTextHandler(io.Discard, nil)), session)
	if !errors.Is(err, execErr) || !execCalled {
		t.Fatalf("failed reexec result called=%v err=%v", execCalled, err)
	}
	if _, err := session.CloseAndPurgeIfLast(); err != nil {
		t.Fatalf("ordinary defer after failed reexec was not idempotent: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".clx", "auth", "purge-on-last-exit")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed reexec orphaned purge request: %v", err)
	}
}

func TestWrapperAutoUpdateFinalizationDefersPurgeToPeer(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_WRAPPER_RESTARTED", "")
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"shared"}}`)); err != nil {
		t.Fatal(err)
	}
	session, err := claude.StartAuthSession(true)
	if err != nil {
		t.Fatal(err)
	}
	peer, err := claude.StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	oldUpdate, oldExec := wrapperSelfUpdate, wrapperReExec
	t.Cleanup(func() {
		wrapperSelfUpdate = oldUpdate
		wrapperReExec = oldExec
	})
	wrapperSelfUpdate = func(context.Context, *config.Config, string, string, string, *slog.Logger) (string, error) {
		return "/tmp/clx-updated", nil
	}
	wrapperReExec = func(string, []string) error { return nil }
	target, url, sha := "0.6.46", "https://updates.invalid/clx", strings.Repeat("b", 64)
	auth := &orchestrator.AuthRetrieveResponse{Versions: &orchestrator.VersionSummary{
		AutoUpdateEnabled: true,
		WrapperVersion:    &target,
		WrapperURL:        &url,
		WrapperSHA256:     &sha,
	}}
	if err := maybeEnsureWrapper(context.Background(), &config.Config{}, auth, "0.6.45", false, true, slog.New(slog.NewTextHandler(io.Discard, nil)), session); err != nil {
		t.Fatal(err)
	}
	if !claude.HasUsableAuth() {
		t.Fatal("reexec finalization purged credentials still used by peer")
	}
	if err := session.SetPurgeOnLastExit(false); err == nil {
		t.Fatal("updated wrapper session remained open after reexec finalization")
	}
	if purged, err := peer.CloseAndPurgeIfLast(); err != nil || !purged {
		t.Fatalf("peer did not service inherited purge request: purged=%v err=%v", purged, err)
	}
	if claude.HasUsableAuth() {
		t.Fatal("credentials survived final peer after wrapper reexec")
	}
}

func TestNeedsInteractiveAuthRecovery(t *testing.T) {
	cases := []struct {
		name        string
		decision    orchestrator.AuthDecision
		uploadErr   error
		localUsable bool
		want        bool
	}{
		{
			name: "live verification failure",
			decision: orchestrator.AuthDecision{
				Status: "valid",
				Reason: "Claude credentials failed live verification (login expired).",
			},
			localUsable: true,
			want:        true,
		},
		{
			name: "missing with retryable upload failure keeps valid local",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "missing",
			},
			uploadErr:   &orchestrator.HTTPError{StatusCode: http.StatusServiceUnavailable},
			localUsable: true,
			want:        false,
		},
		{
			name: "missing without local auth starts recovery",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "missing",
			},
			want: true,
		},
		{
			name: "normal valid auth",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "valid",
			},
			localUsable: true,
			want:        false,
		},
		{
			name: "valid server status without runnable local starts recovery",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "valid",
			},
			want: true,
		},
		{
			name: "disabled host is not a login recovery",
			decision: orchestrator.AuthDecision{
				Status: "disabled",
				Reason: "Auth API disabled by administrator.",
			},
			want: false,
		},
		{
			name: "unsafe rotated runner writeback starts a fresh login",
			decision: orchestrator.AuthDecision{
				Allowed: true,
				Status:  "missing",
			},
			uploadErr: &orchestrator.HTTPError{StatusCode: http.StatusServiceUnavailable, Code: "runner_updated_auth_invalid"},
			want:      true,
		},
		{
			name: "definitive candidate rejection reauthenticates despite structural local token",
			decision: orchestrator.AuthDecision{
				Status: "credential_rejected",
			},
			uploadErr:   &orchestrator.HTTPError{StatusCode: http.StatusUnprocessableEntity, Code: "validation_failed"},
			localUsable: true,
			want:        true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := needsInteractiveAuthRecovery(tc.decision, tc.uploadErr, tc.localUsable); got != tc.want {
				t.Fatalf("needsInteractiveAuthRecovery() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestFailedServerHeadWithExplicitlyDistinctLocalCandidateDefersWithoutLogin(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	lastRefresh := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	if err := claude.WriteAuth(json.RawMessage(fmt.Sprintf(`{"last_refresh":%q,"claudeAiOauth":{"accessToken":"distinct-local","refreshToken":"refresh"}}`, lastRefresh))); err != nil {
		t.Fatal(err)
	}
	authPath, err := claude.AuthPath()
	if err != nil {
		t.Fatal(err)
	}
	candidateSeen := false
	distinct := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req orchestrator.BundleRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode bundle request: %v", err)
		}
		candidateSeen = strings.Contains(string(req.AuthCandidate), "distinct-local")
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"status":"success","data":{"auth":{"status":"outdated","verification_state":"failed","candidate_matches_failed_canonical":%t}}}`, distinct)
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	resp, bootstrapErr, _, _, _, _, _ := bootstrap(context.Background(), client, logger, true, authPath)
	if bootstrapErr != nil {
		t.Fatal(bootstrapErr)
	}
	if !candidateSeen {
		t.Fatal("distinct runnable local generation was not retried as bundle candidate")
	}
	dec := decideAuth(resp, nil, authPath, true)
	if !dec.Allowed || !dec.LocalUsable {
		t.Fatalf("failed server head blocked explicitly distinct local candidate: %+v", dec)
	}
	if needsInteractiveAuthRecovery(dec, nil, claude.HasUsableAuth()) {
		t.Fatal("transient failed-head arbitration unnecessarily requested another login")
	}

	same := true
	resp.CandidateMatchesFailedHead = &same
	dec = decideAuth(resp, nil, authPath, true)
	if dec.Allowed || !needsInteractiveAuthRecovery(dec, nil, claude.HasUsableAuth()) {
		t.Fatalf("known matching failed candidate was allowed: %+v", dec)
	}
	resp.CandidateMatchesFailedHead = nil
	dec = decideAuth(resp, nil, authPath, true)
	if dec.Allowed {
		t.Fatalf("absent candidate identity proof allowed failed canonical fallback: %+v", dec)
	}
}

func TestDefinitivelyRejectedBundleCandidateRequiresLoginEvenWhenConcurrent(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-24T07:00:00Z","claudeAiOauth":{"accessToken":"rejected-local"}}`)); err != nil {
		t.Fatal(err)
	}
	authPath, err := claude.AuthPath()
	if err != nil {
		t.Fatal(err)
	}
	resp := &orchestrator.AuthRetrieveResponse{
		Status:                      "missing",
		CandidateCredentialRejected: true,
	}
	dec := decideAuth(resp, nil, authPath, true)
	if dec.Allowed || dec.Status != "credential_rejected" {
		t.Fatalf("definitive bundle rejection decision=%+v", dec)
	}
	if concurrent := orchestrator.ApplyConcurrent(dec, authPath, localProbe); concurrent.Allowed {
		t.Fatalf("concurrent mode upgraded definitive rejection: %+v", concurrent)
	}
	if !needsInteractiveAuthRecovery(dec, nil, claude.HasUsableAuth()) {
		t.Fatal("definitively rejected candidate did not enter direct login recovery")
	}
}

func TestTransientAuthErrorRequiresRunnableFreshLocalOAuth(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	authPath, err := claude.AuthPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	expired := time.Now().Add(-time.Hour).UnixMilli()
	if err := os.WriteFile(
		authPath,
		[]byte(fmt.Sprintf(`{"claudeAiOauth":{"accessToken":"expired-no-refresh","expiresAt":%d}}`, expired)),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	resp := &orchestrator.AuthRetrieveResponse{Status: "error"}
	dec := decideAuth(resp, errors.New("temporary network outage"), authPath, true)
	if dec.Allowed || dec.LocalUsable {
		t.Fatalf("expired OAuth bypassed transient-error freshness gate: %+v", dec)
	}

	refreshFuture := time.Now().Add(24 * time.Hour).UnixMilli()
	if err := os.WriteFile(
		authPath,
		[]byte(fmt.Sprintf(`{"claudeAiOauth":{"accessToken":"expired-refreshable","refreshToken":"refresh","expiresAt":%d,"refreshTokenExpiresAt":%d}}`, expired, refreshFuture)),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	dec = decideAuth(resp, errors.New("temporary network outage"), authPath, true)
	if !dec.Allowed || !dec.LocalUsable {
		t.Fatalf("refreshable OAuth failed transient-error freshness gate: %+v", dec)
	}
}

func TestExpiredStructuralOAuthStillRequestsInteractiveRecovery(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	authPath, err := claude.AuthPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	expired := time.Now().Add(-time.Hour).UnixMilli()
	if err := os.WriteFile(
		authPath,
		[]byte(fmt.Sprintf(`{"claudeAiOauth":{"accessToken":"expired-no-refresh","expiresAt":%d}}`, expired)),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if !claude.HasUsableAuth() {
		t.Fatal("fixture must remain structurally usable")
	}
	dec := decideAuth(&orchestrator.AuthRetrieveResponse{Status: "missing"}, nil, authPath, true)
	if !needsInteractiveAuthRecovery(dec, nil, localAuthFresh(authPath, true)) {
		t.Fatalf("expired local plus missing server did not request login: %+v", dec)
	}
}

func TestBundleRejectionIsBoundToSubmittedCredentialGeneration(t *testing.T) {
	for _, tc := range []struct {
		name              string
		replacement       string
		wantRejected      bool
		wantLoginRecovery bool
	}{
		{
			name:        "different in-flight login survives",
			replacement: `{"claudeAiOauth":{"accessToken":"candidate-c","refreshToken":"refresh-c"}}`,
		},
		{
			name:        "same access with rotated refresh survives",
			replacement: `{"claudeAiOauth":{"accessToken":"candidate-a","refreshToken":"changed-metadata"}}`,
		},
		{
			name:              "byte-different same credential pair remains rejected",
			replacement:       `{"metadata":"changed","claudeAiOauth":{"refreshToken":"refresh-a","accessToken":"candidate-a"}}`,
			wantRejected:      true,
			wantLoginRecovery: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-24T07:00:00Z","claudeAiOauth":{"accessToken":"candidate-a","refreshToken":"refresh-a"}}`)); err != nil {
				t.Fatal(err)
			}
			authPath, err := claude.AuthPath()
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var req orchestrator.BundleRequest
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
					t.Errorf("decode bundle request: %v", err)
				}
				if !strings.Contains(string(req.AuthCandidate), "candidate-a") {
					t.Errorf("submitted candidate missing: %s", req.AuthCandidate)
				}
				if err := os.WriteFile(authPath, []byte(tc.replacement), 0o600); err != nil {
					t.Errorf("write in-flight native login: %v", err)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"status":"success","data":{"auth":{"status":"missing","candidate_credential_rejected":true}}}`))
			}))
			defer server.Close()
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
			if err != nil {
				t.Fatal(err)
			}
			resp, bootstrapErr, _, _, _, _, _ := bootstrap(context.Background(), client, logger, true, authPath)
			if bootstrapErr != nil {
				t.Fatal(bootstrapErr)
			}
			if resp.CandidateCredentialRejected != tc.wantRejected {
				t.Fatalf("candidate rejection=%v want=%v response=%+v", resp.CandidateCredentialRejected, tc.wantRejected, resp)
			}
			dec := decideAuth(resp, nil, authPath, true)
			if tc.wantRejected == dec.Allowed {
				t.Fatalf("decision after in-flight replacement=%+v", dec)
			}
			if got := needsInteractiveAuthRecovery(dec, nil, claude.HasUsableAuth()); got != tc.wantLoginRecovery {
				t.Fatalf("login recovery=%v want=%v decision=%+v", got, tc.wantLoginRecovery, dec)
			}
			raw, err := os.ReadFile(authPath)
			if err != nil || string(raw) != tc.replacement {
				t.Fatalf("in-flight native credential changed: %q err=%v", raw, err)
			}
		})
	}
}

func TestRecoverClaudeAuthRunsDirectLoginDuringConcurrentSessionWithoutPrompt(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	bin := filepath.Join(t.TempDir(), "claude")
	writeTestScript(t, bin, `#!/bin/sh
mkdir -p "$HOME/.claude"
printf '%s' '{"claudeAiOauth":{"accessToken":"interactive-login","refreshToken":"refresh"}}' > "$HOME/.claude/.credentials.json"
`)
	t.Setenv("CLX_CLAUDE_BIN", bin)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"updated","verification_state":"verified"}`))
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	peer, err := claude.StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	current, err := claude.StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = current.CloseAndPurgeIfLast()
		_, _ = peer.CloseAndPurgeIfLast()
	})
	previousTerminal := lifecycleIsTerminal
	lifecycleIsTerminal = func(int) bool { return true }
	t.Cleanup(func() { lifecycleIsTerminal = previousTerminal })

	var recoverErr error
	stderr := captureStderr(t, func() {
		recoverErr = recoverClaudeAuth(
			context.Background(),
			&config.Config{},
			client,
			logger,
			"Claude credentials are missing.",
			current,
		)
	})
	if recoverErr != nil {
		t.Fatal(recoverErr)
	}
	if strings.Contains(stderr, "[y/N]") {
		t.Fatalf("direct recovery retained confirmation prompt: %q", stderr)
	}
	if !strings.Contains(stderr, "Starting `claude auth login`") {
		t.Fatalf("direct login was not announced: %q", stderr)
	}
	if !claude.HasUsableAuth() {
		t.Fatal("direct concurrent recovery did not leave runnable auth")
	}
}

func TestRecoverClaudeAuthCanonicalWinContinuesWithVerifiedCredential(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-24T06:00:00Z","claudeAiOauth":{"accessToken":"logged-out"}}`)); err != nil {
		t.Fatal(err)
	}
	old, err := claude.ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	if marked, err := claude.RecordExplicitLogout(old.Generation); err != nil || !marked {
		t.Fatalf("record explicit logout=%v err=%v", marked, err)
	}
	if err := os.MkdirAll(filepath.Dir(old.Path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(old.Path, old.Raw, 0o600); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "claude")
	writeTestScript(t, bin, `#!/bin/sh
mkdir -p "$HOME/.claude"
printf '%s' '{"claudeAiOauth":{"accessToken":"submitted-login","refreshToken":"refresh"}}' > "$HOME/.claude/.credentials.json"
`)
	t.Setenv("CLX_CLAUDE_BIN", bin)
	canonicalDigest := strings.Repeat("c", 64)
	canonicalStamp := time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(
			w,
			`{"status":"outdated","verification_state":"verified","candidate_credential_rejected":true,"candidate_rejected_definitive":true,"canonical_digest":%q,"canonical_last_refresh":%q,"auth":{"last_refresh":%q,"claudeAiOauth":{"accessToken":"verified-canonical","refreshToken":"canonical-refresh"}}}`,
			canonicalDigest,
			canonicalStamp,
			canonicalStamp,
		)
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	previousTerminal := lifecycleIsTerminal
	lifecycleIsTerminal = func(int) bool { return true }
	t.Cleanup(func() { lifecycleIsTerminal = previousTerminal })

	var recoverErr error
	stderr := captureStderr(t, func() {
		recoverErr = recoverClaudeAuth(context.Background(), &config.Config{}, client, logger, "logged out", nil)
	})
	if recoverErr != nil {
		t.Fatal(recoverErr)
	}
	if !strings.Contains(stderr, "Submitted login was not accepted") {
		t.Fatalf("canonical-win outcome was not reported accurately: %q", stderr)
	}
	if claude.HasLogoutIntent() {
		t.Fatal("verified different canonical did not clear logout marker")
	}
	raw, err := claude.ReadAuth()
	if err != nil || !strings.Contains(string(raw), "verified-canonical") {
		t.Fatalf("canonical-win native auth=%q err=%v", raw, err)
	}
	authPath, _ := claude.AuthPath()
	resp := &orchestrator.AuthRetrieveResponse{
		Status:                      "outdated",
		VerificationState:           "verified",
		CandidateCredentialRejected: true,
		CandidateRejectedDefinitive: true,
		CanonicalDigest:             canonicalDigest,
		CanonicalLastRefresh:        canonicalStamp,
		Auth:                        json.RawMessage(fmt.Sprintf(`{"last_refresh":%q,"claudeAiOauth":{"accessToken":"verified-canonical","refreshToken":"canonical-refresh"}}`, canonicalStamp)),
	}
	if dec := decideAuth(resp, nil, authPath, true); !dec.Allowed {
		t.Fatalf("installed verified canonical remained refused: %+v", dec)
	}
}

func TestRecoverClaudeAuthTransientUploadUsesFreshLoginAndClearsOldMarker(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-24T06:00:00Z","claudeAiOauth":{"accessToken":"logged-out"}}`)); err != nil {
		t.Fatal(err)
	}
	old, err := claude.ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	if marked, err := claude.RecordExplicitLogout(old.Generation); err != nil || !marked {
		t.Fatalf("record explicit logout=%v err=%v", marked, err)
	}
	bin := filepath.Join(t.TempDir(), "claude")
	writeTestScript(t, bin, `#!/bin/sh
mkdir -p "$HOME/.claude"
printf '%s' '{"claudeAiOauth":{"accessToken":"fresh-offline-login","refreshToken":"refresh"}}' > "$HOME/.claude/.credentials.json"
`)
	t.Setenv("CLX_CLAUDE_BIN", bin)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"status":"error","code":"runner_unreachable","message":"retry later"}`))
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	previousTerminal := lifecycleIsTerminal
	lifecycleIsTerminal = func(int) bool { return true }
	t.Cleanup(func() { lifecycleIsTerminal = previousTerminal })

	if err := recoverClaudeAuth(context.Background(), &config.Config{}, client, logger, "logged out", nil); err != nil {
		t.Fatal(err)
	}
	if claude.HasLogoutIntent() || !claude.HasUsableAuth() {
		t.Fatal("fresh login was not authorized after transient upload deferral")
	}
}

func TestRecoverClaudeAuthMetadataRewriteCannotClearOldMarker(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := claude.WriteAuth(json.RawMessage(`{"claudeAiOauth":{"accessToken":"same","refreshToken":"same-refresh"}}`)); err != nil {
		t.Fatal(err)
	}
	old, err := claude.ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	if marked, err := claude.RecordExplicitLogout(old.Generation); err != nil || !marked {
		t.Fatalf("record explicit logout=%v err=%v", marked, err)
	}
	if err := os.MkdirAll(filepath.Dir(old.Path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(old.Path, old.Raw, 0o600); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "claude")
	writeTestScript(t, bin, `#!/bin/sh
mkdir -p "$HOME/.claude"
printf '%s' '{"metadata":"changed","claudeAiOauth":{"refreshToken":"same-refresh","accessToken":"same"}}' > "$HOME/.claude/.credentials.json"
`)
	t.Setenv("CLX_CLAUDE_BIN", bin)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	previousTerminal := lifecycleIsTerminal
	lifecycleIsTerminal = func(int) bool { return true }
	t.Cleanup(func() { lifecycleIsTerminal = previousTerminal })

	err = recoverClaudeAuth(context.Background(), &config.Config{}, client, logger, "logged out", nil)
	if err == nil || !strings.Contains(err.Error(), "credential pair") {
		t.Fatalf("metadata-only recovery error=%v", err)
	}
	if requests.Load() != 0 {
		t.Fatalf("metadata-only recovery reached server: %d requests", requests.Load())
	}
	if !claude.HasLogoutIntent() {
		t.Fatal("metadata-only recovery cleared old logout marker")
	}
}

func TestRecoverClaudeAuthNoOpLoginCannotBlessExpiredOAuth(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	authPath, err := claude.AuthPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	expired := time.Now().Add(-time.Hour).UnixMilli()
	if err := os.WriteFile(
		authPath,
		[]byte(fmt.Sprintf(`{"claudeAiOauth":{"accessToken":"expired-no-refresh","expiresAt":%d}}`, expired)),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "claude")
	writeTestScript(t, bin, "#!/bin/sh\nexit 0\n")
	t.Setenv("CLX_CLAUDE_BIN", bin)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	previousTerminal := lifecycleIsTerminal
	lifecycleIsTerminal = func(int) bool { return true }
	t.Cleanup(func() { lifecycleIsTerminal = previousTerminal })

	err = recoverClaudeAuth(context.Background(), &config.Config{}, client, logger, "expired", nil)
	if err == nil || !strings.Contains(err.Error(), "without fresh runnable local credentials") {
		t.Fatalf("no-op login error=%v", err)
	}
	if requests.Load() != 0 {
		t.Fatalf("no-op expired login reached server: %d requests", requests.Load())
	}
}

func TestHeadlessAuthRecoveryReturnsExactLoginAction(t *testing.T) {
	previousTerminal := lifecycleIsTerminal
	lifecycleIsTerminal = func(int) bool { return false }
	t.Cleanup(func() { lifecycleIsTerminal = previousTerminal })
	err := recoverClaudeAuth(context.Background(), nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)), "", nil)
	if !errors.Is(err, errAuthRecoveryNonInteractive) || err.Error() != "Claude authentication required; run `clx auth login` interactively." {
		t.Fatalf("headless recovery error=%q", err)
	}
}

func TestRetryableAuthSyncFailurePreservesPolicyAndUnsafeDenials(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{name: "runner outage", err: &orchestrator.HTTPError{StatusCode: http.StatusServiceUnavailable, Code: "runner_unreachable"}, want: true},
		{name: "rate limit", err: &orchestrator.HTTPError{StatusCode: http.StatusTooManyRequests, Code: "rate_limited"}, want: true},
		{name: "deadline", err: context.DeadlineExceeded, want: true},
		{name: "API kill switch", err: &orchestrator.HTTPError{StatusCode: http.StatusServiceUnavailable, Code: "api_disabled"}},
		{name: "unsafe runner writeback", err: &orchestrator.HTTPError{StatusCode: http.StatusServiceUnavailable, Code: "runner_updated_auth_invalid"}},
		{name: "engine disabled", err: &orchestrator.HTTPError{StatusCode: http.StatusForbidden, Code: "engine_disabled"}},
		{name: "cancelled", err: context.Canceled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := isRetryableAuthSyncFailure(tc.err); got != tc.want {
				t.Fatalf("isRetryableAuthSyncFailure(%v)=%v want=%v", tc.err, got, tc.want)
			}
		})
	}
}

func TestShouldWriteServerAuth(t *testing.T) {
	auth := []byte(`{"claudeAiOauth":{"accessToken":"token"}}`)
	cases := []struct {
		status string
		auth   []byte
		want   bool
	}{
		{"outdated", auth, true},
		{"updated", auth, true},
		{"missing", auth, true},
		{" OUTDATED ", auth, true},
		{"valid", auth, true},
		{"outdated", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.status, func(t *testing.T) {
			if got := shouldWriteServerAuth(tc.status, tc.auth); got != tc.want {
				t.Fatalf("shouldWriteServerAuth(%q, len=%d) = %v, want %v", tc.status, len(tc.auth), got, tc.want)
			}
		})
	}
}

func TestPostRunABLoginRacePreservesBWhenAResponseArrivesLast(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	authPath := filepath.Join(claudeDir, ".credentials.json")
	old := `{"claudeAiOauth":{"accessToken":"old"}}`
	loginA := `{"claudeAiOauth":{"accessToken":"login-a"}}`
	loginB := `{"claudeAiOauth":{"accessToken":"login-b"}}`
	if err := os.WriteFile(authPath, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	before := snapshotAuthGeneration()
	if err := os.WriteFile(authPath, []byte(loginA), 0o600); err != nil {
		t.Fatal(err)
	}

	requestSeen := make(chan string, 1)
	releaseA := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requestSeen <- string(body)
		<-releaseA
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"updated","auth":{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"login-a"}}}`))
	}))
	defer server.Close()
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test"})
	if err != nil {
		t.Fatal(err)
	}
	type result struct {
		status string
		tone   ui.Tone
	}
	done := make(chan result, 1)
	go func() {
		status, tone := maybePostRunAuthUpload(client, slog.New(slog.NewTextHandler(io.Discard, nil)), before, nil)
		done <- result{status: status, tone: tone}
	}()
	body := <-requestSeen
	if !strings.Contains(body, "login-a") {
		t.Fatalf("A upload did not contain login A: %s", body)
	}
	// B renews while A's store is in flight. A's late canonical response must
	// never rename login A over the newer shared native file.
	if err := os.WriteFile(authPath, []byte(loginB), 0o600); err != nil {
		t.Fatal(err)
	}
	close(releaseA)
	got := <-done
	if got.tone != ui.ToneOK || got.status != "newer local kept" {
		t.Fatalf("post-run result = (%q,%v)", got.status, got.tone)
	}
	raw, err := os.ReadFile(authPath)
	if err != nil || string(raw) != loginB {
		t.Fatalf("late A response clobbered B: raw=%q err=%v", raw, err)
	}
}

func TestPostRunNativeSlashLoginClockRollbackConvergesBeforeImmediateNextRun(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	authPath := filepath.Join(home, ".claude", ".credentials.json")
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	x := []byte(`{"claudeAiOauth":{"accessToken":"native-x"}}`)
	if err := os.WriteFile(authPath, x, 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := claude.ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}

	// X was accepted while the host clock was correct. The clock then moves
	// backwards before Claude writes raw, unbound native Y with an old mtime.
	// The wrapper-owned logical generation must remain monotonic independently
	// of that local wall clock.
	xStamp := time.Now().UTC().Add(30 * time.Minute).Truncate(time.Microsecond)
	stateDir := filepath.Join(home, ".clx", "auth")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	state, err := json.Marshal(map[string]any{
		"version":          1,
		"digest":           before.Generation.Digest,
		"last_refresh":     xStamp.Format(time.RFC3339Nano),
		"canonical_digest": strings.Repeat("a", 64),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "generation.json"), state, 0o600); err != nil {
		t.Fatal(err)
	}

	y := []byte(`{"claudeAiOauth":{"accessToken":"native-y"}}`)
	if err := os.WriteFile(authPath, y, 0o600); err != nil {
		t.Fatal(err)
	}
	rolledBackMtime := time.Now().UTC().Add(-24 * time.Hour)
	if err := os.Chtimes(authPath, rolledBackMtime, rolledBackMtime); err != nil {
		t.Fatal(err)
	}

	acceptedStamp := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/auth":
			var req struct {
				Command string          `json:"command"`
				Auth    json.RawMessage `json:"auth"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Errorf("decode post-run store: %v", err)
				return
			}
			if req.Command != "store" || !strings.Contains(string(req.Auth), "native-y") {
				t.Errorf("post-run request = command %q auth %s", req.Command, req.Auth)
				return
			}
			var candidate struct {
				LastRefresh string `json:"last_refresh"`
			}
			if err := json.Unmarshal(req.Auth, &candidate); err != nil {
				t.Errorf("decode post-run candidate: %v", err)
				return
			}
			candidateStamp, err := time.Parse(time.RFC3339Nano, candidate.LastRefresh)
			if err != nil {
				t.Errorf("parse post-run generation: %v", err)
				return
			}
			if !candidateStamp.After(xStamp) {
				// Model the single API/runner correctly preserving canonical X
				// when a wrapper presents an older candidate generation.
				_, _ = fmt.Fprintf(w, `{"status":"outdated","verification_state":"verified","canonical_digest":%q,"canonical_last_refresh":%q,"auth":{"last_refresh":%q,"claudeAiOauth":{"accessToken":"native-x"}}}`, strings.Repeat("a", 64), xStamp.Format(time.RFC3339Nano), xStamp.Format(time.RFC3339Nano))
				return
			}
			acceptedStamp = candidate.LastRefresh
			_, _ = w.Write([]byte(`{"status":"valid","verification_state":"verified"}`))
		case "/sync/bootstrap":
			var req orchestrator.BundleRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Errorf("decode immediate next bootstrap: %v", err)
				return
			}
			if !strings.Contains(string(req.AuthCandidate), "native-y") {
				t.Errorf("immediate next clx did not retain Y: %s", req.AuthCandidate)
			}
			var candidate struct {
				LastRefresh string `json:"last_refresh"`
			}
			if err := json.Unmarshal(req.AuthCandidate, &candidate); err != nil {
				t.Errorf("decode immediate next candidate: %v", err)
			} else if candidate.LastRefresh != acceptedStamp {
				t.Errorf("immediate next clx restamped Y: got %q want %q", candidate.LastRefresh, acceptedStamp)
			}
			_, _ = w.Write([]byte(`{"status":"success","data":{"auth":{"status":"valid","verification_state":"verified"}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
	if err != nil {
		t.Fatal(err)
	}

	status, tone := maybePostRunAuthUpload(client, logger, before.Generation, nil)
	if status != "uploaded" || tone != ui.ToneOK {
		t.Fatalf("post-run Y convergence = (%q,%v)", status, tone)
	}
	if acceptedStamp == "" {
		t.Fatal("server never accepted monotonic Y generation")
	}
	if raw, err := os.ReadFile(authPath); err != nil || string(raw) != string(y) {
		t.Fatalf("normal close did not retain Y: %q err=%v", raw, err)
	}
	resp, bootstrapErr, _, _, _, _, _ := bootstrap(context.Background(), client, logger, false, authPath)
	if bootstrapErr != nil || resp == nil || resp.Status != "valid" {
		t.Fatalf("immediate next clx bootstrap = resp=%+v err=%v", resp, bootstrapErr)
	}
	if raw, err := os.ReadFile(authPath); err != nil || string(raw) != string(y) {
		t.Fatalf("immediate next clx changed Y: %q err=%v", raw, err)
	}
}

func TestPostRunStoreUpdatesSessionFromAPIAuthoritativeSecurity(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T09:00:00Z","claudeAiOauth":{"accessToken":"old"}}`)); err != nil {
		t.Fatal(err)
	}
	before := snapshotAuthGeneration()
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"renewed"}}`)); err != nil {
		t.Fatal(err)
	}
	session, err := claude.StartAuthSession(false)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"updated","host":{"secure":false}}`))
	}))
	defer server.Close()
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test"})
	if err != nil {
		t.Fatal(err)
	}
	status, tone := maybePostRunAuthUpload(client, slog.New(slog.NewTextHandler(io.Discard, nil)), before, session)
	if status != "uploaded" || tone != ui.ToneOK {
		t.Fatalf("post-run store result=(%q,%v)", status, tone)
	}
	if purged, err := session.CloseAndPurgeIfLast(); err != nil || !purged {
		t.Fatalf("API-insecure session finalization purged=%v err=%v", purged, err)
	}
	if claude.HasUsableAuth() {
		t.Fatal("API-authoritative insecure response did not purge changed auth")
	}
}

func TestPostRunLoginAppliesRunnerWritebackAlongsidePeerChild(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T07:00:00Z","claudeAiOauth":{"accessToken":"old"}}`)); err != nil {
		t.Fatal(err)
	}
	before := snapshotAuthGeneration()
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T08:00:00Z","claudeAiOauth":{"accessToken":"slash-login"}}`)); err != nil {
		t.Fatal(err)
	}
	ready := filepath.Join(home, "peer-ready")
	release := filepath.Join(home, "peer-release")
	t.Setenv("CLX_TEST_READY", ready)
	t.Setenv("CLX_TEST_RELEASE", release)
	bin := filepath.Join(t.TempDir(), "claude")
	writeTestScript(t, bin, `#!/bin/sh
: > "$CLX_TEST_READY"
while [ ! -e "$CLX_TEST_RELEASE" ]; do sleep 0.01; done
`)
	t.Setenv("CLX_CLAUDE_BIN", bin)
	peerDone := make(chan error, 1)
	go func() {
		_, runErr := claude.Run(context.Background(), &config.Config{}, nil)
		peerDone <- runErr
	}()
	t.Cleanup(func() { _ = os.WriteFile(release, nil, 0o600) })
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("peer Claude child did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"updated","verification_state":"verified","canonical_last_refresh":"2026-07-17T09:00:00Z","auth":{"last_refresh":"2026-07-17T09:00:00Z","claudeAiOauth":{"accessToken":"runner-refreshed"}}}`))
	}))
	defer server.Close()
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test"})
	if err != nil {
		t.Fatal(err)
	}
	status, tone := maybePostRunAuthUpload(client, slog.New(slog.NewTextHandler(io.Discard, nil)), before, nil)
	if status != "uploaded" || tone != ui.ToneOK {
		t.Fatalf("post-run login=(%q,%v)", status, tone)
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
	if err != nil || !strings.Contains(string(raw), "runner-refreshed") {
		t.Fatalf("runner writeback not applied alongside peer child: %q err=%v", raw, err)
	}
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := <-peerDone; err != nil {
		t.Fatal(err)
	}
}

func TestPostRunUploadAbortsWhenLogoutIntentIsAlreadyActive(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T09:00:00Z","claudeAiOauth":{"accessToken":"old"}}`)); err != nil {
		t.Fatal(err)
	}
	before := snapshotAuthGeneration()
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"renewed"}}`)); err != nil {
		t.Fatal(err)
	}
	current, err := claude.ReadAuthSnapshot(false)
	if err != nil {
		t.Fatal(err)
	}
	if marked, err := claude.RecordDeferredExplicitLogout(current.Generation); err != nil || !marked {
		t.Fatalf("record logout = %v, %v", marked, err)
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"updated"}`))
	}))
	defer server.Close()
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test"})
	if err != nil {
		t.Fatal(err)
	}
	status, tone := maybePostRunAuthUpload(client, slog.New(slog.NewTextHandler(io.Discard, nil)), before, nil)
	if status != "logged out" || tone != ui.ToneWarn {
		t.Fatalf("post-run with active logout = (%q,%v)", status, tone)
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("post-run uploaded after active logout: %d requests", got)
	}
}

func TestPostRunUploadSerializesOverlappingExplicitLogout(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T09:00:00Z","claudeAiOauth":{"accessToken":"old"}}`)); err != nil {
		t.Fatal(err)
	}
	before := snapshotAuthGeneration()
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"renewed"}}`)); err != nil {
		t.Fatal(err)
	}
	requestSeen := make(chan struct{})
	releaseStore := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(requestSeen)
		<-releaseStore
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"updated","auth":{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"renewed"}}}`))
	}))
	defer server.Close()
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test"})
	if err != nil {
		t.Fatal(err)
	}
	uploadDone := make(chan struct{})
	go func() {
		_, _ = maybePostRunAuthUpload(client, slog.New(slog.NewTextHandler(io.Discard, nil)), before, nil)
		close(uploadDone)
	}()
	<-requestSeen
	logoutDone := make(chan error, 1)
	go func() {
		current, err := claude.ReadAuthSnapshot(false)
		if err == nil {
			_, err = claude.RecordDeferredExplicitLogout(current.Generation)
		}
		logoutDone <- err
	}()
	select {
	case err := <-logoutDone:
		t.Fatalf("logout crossed an in-flight AuthStore boundary: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(releaseStore)
	<-uploadDone
	if err := <-logoutDone; err != nil {
		t.Fatal(err)
	}
	if active, err := claude.LogoutIntentActive(); err != nil || !active {
		t.Fatalf("overlapping logout intent = %v, %v", active, err)
	}
	if claude.HasUsableAuth() {
		t.Fatal("post-run write-back resurrected auth after serialized logout")
	}
}

func TestBundleCandidateSerializesOverlappingExplicitLogout(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T10:00:00Z","claudeAiOauth":{"accessToken":"bundle-login"}}`)); err != nil {
		t.Fatal(err)
	}
	authPath, err := claude.AuthPath()
	if err != nil {
		t.Fatal(err)
	}
	requestSeen := make(chan struct{})
	releaseStore := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req orchestrator.BundleRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode bundle request: %v", err)
		}
		if len(req.AuthCandidate) == 0 || !strings.Contains(string(req.AuthCandidate), "bundle-login") {
			t.Errorf("bundle omitted auth candidate: %s", req.AuthCandidate)
		}
		close(requestSeen)
		<-releaseStore
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"auth":{"status":"valid","verification_state":"verified"}}}`))
	}))
	defer server.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	bootstrapDone := make(chan error, 1)
	go func() {
		_, bootstrapErr, _, _, _, _, _ := bootstrap(context.Background(), client, logger, false, authPath)
		bootstrapDone <- bootstrapErr
	}()
	<-requestSeen
	logoutDone := make(chan error, 1)
	go func() {
		current, readErr := claude.ReadAuthSnapshot(false)
		if readErr == nil {
			_, readErr = claude.RecordDeferredExplicitLogout(current.Generation)
		}
		logoutDone <- readErr
	}()
	select {
	case err := <-logoutDone:
		t.Fatalf("logout crossed in-flight bundle candidate boundary: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(releaseStore)
	if err := <-bootstrapDone; err != nil {
		t.Fatal(err)
	}
	if err := <-logoutDone; err != nil {
		t.Fatal(err)
	}
	if active, err := claude.LogoutIntentActive(); err != nil || !active {
		t.Fatalf("overlapping bundle logout intent = %v, %v", active, err)
	}
}

func TestBundleClearsOldLogoutMarkerOnlyAfterDifferentLoginIsAccepted(t *testing.T) {
	for _, tc := range []struct {
		name      string
		authReply string
		wantHold  bool
	}{
		{name: "accepted", authReply: `{"status":"valid","verification_state":"verified"}`},
		{name: "canonical wins", authReply: `{"status":"outdated","verification_state":"verified","canonical_last_refresh":"2026-07-17T11:00:00Z","auth":{"last_refresh":"2026-07-17T11:00:00Z","claudeAiOauth":{"accessToken":"canonical"}}}`, wantHold: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			if err := claude.WriteAuth(json.RawMessage(`{"last_refresh":"2026-07-17T09:00:00Z","claudeAiOauth":{"accessToken":"logged-out"}}`)); err != nil {
				t.Fatal(err)
			}
			old, err := claude.ReadAuthSnapshot(false)
			if err != nil {
				t.Fatal(err)
			}
			if marked, err := claude.RecordExplicitLogout(old.Generation); err != nil || !marked {
				t.Fatalf("record logout=%v err=%v", marked, err)
			}
			if err := os.WriteFile(old.Path, []byte(`{"claudeAiOauth":{"accessToken":"new-login"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var req orchestrator.BundleRequest
				_ = json.NewDecoder(r.Body).Decode(&req)
				if !strings.Contains(string(req.AuthCandidate), "new-login") {
					t.Errorf("pending login missing from bundle candidate: %s", req.AuthCandidate)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = fmt.Fprintf(w, `{"status":"success","data":{"auth":%s}}`, tc.authReply)
			}))
			defer server.Close()
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			client, err := orchestrator.New(orchestrator.Options{BaseURL: server.URL, APIKey: "test", Logger: logger})
			if err != nil {
				t.Fatal(err)
			}
			_, bootstrapErr, _, _, _, _, _ := bootstrap(context.Background(), client, logger, false, old.Path)
			if bootstrapErr != nil {
				t.Fatal(bootstrapErr)
			}
			if hold := claude.HasLogoutIntent(); hold != tc.wantHold {
				t.Fatalf("logout hold=%v want=%v", hold, tc.wantHold)
			}
			raw, err := os.ReadFile(old.Path)
			if err != nil || !strings.Contains(string(raw), "new-login") {
				t.Fatalf("pending login changed: %q err=%v", raw, err)
			}
		})
	}
}

func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	orig := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	defer func() {
		os.Stderr = orig
		_ = r.Close()
	}()

	fn()
	_ = w.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func writeTestScript(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}
