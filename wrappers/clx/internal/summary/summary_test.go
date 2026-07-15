package summary

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/ui"
)

func TestBuildUsesRunningWrapperVersion(t *testing.T) {
	target := "0.6.23"
	got := Build(context.Background(), Inputs{
		Config:         &config.Config{Wrapper: config.Wrapper{Version: "0.6.18"}},
		WrapperVersion: "0.6.22",
		Auth: &orchestrator.AuthRetrieveResponse{
			Versions: &orchestrator.VersionSummary{WrapperVersion: &target},
		},
	})

	if got.WrapperVersion != "0.6.22" {
		t.Fatalf("WrapperVersion = %q, want running version", got.WrapperVersion)
	}
	if got.WrapperTarget != target {
		t.Fatalf("WrapperTarget = %q, want %q", got.WrapperTarget, target)
	}
	if got.WrapperTone != ui.ToneWarn {
		t.Fatalf("WrapperTone = %q, want warn", got.WrapperTone)
	}
}

func TestBuildHidesOlderClaudeTargetWhenExactIsFalse(t *testing.T) {
	withClaudeVersion(t, "2.1.175")
	target := "2.1.168"
	got := Build(context.Background(), Inputs{
		Auth: &orchestrator.AuthRetrieveResponse{
			Versions: &orchestrator.VersionSummary{
				ClientVersion:             &target,
				ClientVersionEnforceExact: false,
			},
		},
	})

	if got.ClaudeTarget != "" {
		t.Fatalf("ClaudeTarget = %q, want empty", got.ClaudeTarget)
	}
	if got.ClaudeTone != ui.ToneOK {
		t.Fatalf("ClaudeTone = %q, want ok", got.ClaudeTone)
	}
}

func TestBuildShowsNewerClaudeTargetWhenExactIsFalse(t *testing.T) {
	withClaudeVersion(t, "2.1.168")
	target := "2.1.175"
	got := Build(context.Background(), Inputs{
		Auth: &orchestrator.AuthRetrieveResponse{
			Versions: &orchestrator.VersionSummary{
				ClientVersion:             &target,
				ClientVersionEnforceExact: false,
			},
		},
	})

	if got.ClaudeTarget != target {
		t.Fatalf("ClaudeTarget = %q, want %q", got.ClaudeTarget, target)
	}
	if got.ClaudeTone != ui.ToneWarn {
		t.Fatalf("ClaudeTone = %q, want warn", got.ClaudeTone)
	}
}

func TestBuildShowsOlderClaudeTargetWhenExactIsTrue(t *testing.T) {
	withClaudeVersion(t, "2.1.175")
	target := "2.1.168"
	got := Build(context.Background(), Inputs{
		Auth: &orchestrator.AuthRetrieveResponse{
			Versions: &orchestrator.VersionSummary{
				ClientVersion:             &target,
				ClientVersionEnforceExact: true,
			},
		},
	})

	if got.ClaudeTarget != target {
		t.Fatalf("ClaudeTarget = %q, want %q", got.ClaudeTarget, target)
	}
	if got.ClaudeTone != ui.ToneWarn {
		t.Fatalf("ClaudeTone = %q, want warn", got.ClaudeTone)
	}
}

func TestBuildMarksUnknownVersionsAsWarnings(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLX_CLAUDE_BIN", filepath.Join(t.TempDir(), "missing-claude"))
	got := Build(context.Background(), Inputs{
		Auth: &orchestrator.AuthRetrieveResponse{Status: "valid"},
	})
	if got.ClaudeTone != ui.ToneWarn || got.WrapperTone != ui.ToneWarn || got.ResultTone != ui.ToneWarn {
		t.Fatalf("unknown versions rendered healthy: claude=%q wrapper=%q result=%q", got.ClaudeTone, got.WrapperTone, got.ResultTone)
	}
}

func TestBuildAuthToneReflectsWhetherCanonicalAuthWasApplied(t *testing.T) {
	withClaudeVersion(t, "2.1.175")
	for _, tc := range []struct {
		name       string
		authSynced bool
		wantTone   ui.Tone
		wantResult ui.Tone
	}{
		{name: "pending local write", wantTone: ui.ToneWarn, wantResult: ui.ToneWarn},
		{name: "written this run", authSynced: true, wantTone: ui.ToneOK, wantResult: ui.ToneOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Build(context.Background(), Inputs{
				WrapperVersion: "0.6.44",
				Auth:           &orchestrator.AuthRetrieveResponse{Status: "outdated"},
				AuthSynced:     tc.authSynced,
			})
			var authDot *ui.HealthDot
			for i := range got.Dots {
				if got.Dots[i].Name == "auth" {
					authDot = &got.Dots[i]
				}
			}
			if authDot == nil || authDot.Tone != tc.wantTone || authDot.Updated != tc.authSynced || got.ResultTone != tc.wantResult {
				t.Fatalf("auth/result state = dot=%+v result=%q, want tone=%q updated=%t result=%q", authDot, got.ResultTone, tc.wantTone, tc.authSynced, tc.wantResult)
			}
		})
	}
}

func TestBuildStatusOnlyHidesUnprobedResourceHealth(t *testing.T) {
	withClaudeVersion(t, "2.1.175")
	runner := "ok"
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.44",
		Auth:           &orchestrator.AuthRetrieveResponse{Status: "valid", Versions: &orchestrator.VersionSummary{RunnerState: &runner}},
		StatusOnly:     true,
	})
	for _, dot := range got.Dots {
		if dot.Name == "skills" || dot.Name == "config" {
			t.Fatalf("status presented unprobed resource as healthy: %+v", got.Dots)
		}
	}
	if len(got.Dots) != 3 {
		t.Fatalf("status health dots = %+v, want api/auth/runner", got.Dots)
	}
	if got.ResultLabel != "API and auth checks passed." {
		t.Fatalf("status verdict overclaims scope: %q", got.ResultLabel)
	}
}

func TestBuildRunnerFailureWarnsWithoutClaimingLaunchBlocked(t *testing.T) {
	withClaudeVersion(t, "2.1.206")
	runner := "fail"
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.45",
		Auth: &orchestrator.AuthRetrieveResponse{
			Status: "valid",
			Host:   &orchestrator.HostInfo{Secure: true},
			Versions: &orchestrator.VersionSummary{
				RunnerState: &runner,
			},
		},
	})
	for _, dot := range got.Dots {
		if dot.Name == "runner" && dot.Tone != ui.ToneWarn {
			t.Fatalf("failed runner tone = %q, want warning", dot.Tone)
		}
	}
	if got.ResultTone != ui.ToneWarn || strings.Contains(strings.ToLower(got.ResultLabel), "block") {
		t.Fatalf("failed runner result = %q %q", got.ResultTone, got.ResultLabel)
	}
}

func TestBuildResourceSyncHealthIsTruthful(t *testing.T) {
	withClaudeVersion(t, "2.1.175")
	for _, tc := range []struct {
		name        string
		state       ResourceSync
		concurrent  bool
		wantTone    ui.Tone
		wantUpdated bool
		wantResult  ui.Tone
	}{
		{name: "successful unchanged", state: ResourceSync{Checked: true}, wantTone: ui.ToneOK, wantResult: ui.ToneOK},
		{name: "successful updated", state: ResourceSync{Checked: true, Updated: true}, wantTone: ui.ToneOK, wantUpdated: true, wantResult: ui.ToneOK},
		{name: "best effort failure", state: ResourceSync{Checked: true, Err: errors.New("write failed")}, wantTone: ui.ToneWarn, wantResult: ui.ToneWarn},
		{name: "concurrent not attempted", concurrent: true, wantTone: ui.ToneDim, wantResult: ui.ToneOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Build(context.Background(), Inputs{
				WrapperVersion: "0.6.44",
				Auth:           &orchestrator.AuthRetrieveResponse{Status: "valid"},
				Concurrent:     tc.concurrent,
				SkillsSync:     tc.state,
				ConfigSync:     tc.state,
			})
			for _, name := range []string{"skills", "config"} {
				var found *ui.HealthDot
				for i := range got.Dots {
					if got.Dots[i].Name == name {
						found = &got.Dots[i]
					}
				}
				if found == nil || found.Tone != tc.wantTone || found.Updated != tc.wantUpdated {
					t.Fatalf("%s dot = %+v, want tone=%q updated=%t", name, found, tc.wantTone, tc.wantUpdated)
				}
			}
			if got.ResultTone != tc.wantResult {
				t.Fatalf("result = %q (%q), want %q", got.ResultLabel, got.ResultTone, tc.wantResult)
			}
			if tc.state.Err != nil && got.ResultLabel != "Attention — resource sync incomplete; launch continuing." {
				t.Fatalf("resource failure verdict = %q", got.ResultLabel)
			}
		})
	}
}

func TestBuildIncludesFleetSessionRows(t *testing.T) {
	withClaudeVersion(t, "2.1.175")
	got := Build(context.Background(), Inputs{
		WrapperVersion: "0.6.44",
		Auth:           &orchestrator.AuthRetrieveResponse{Status: "valid"},
		Sessions:       &SessionCounts{LocalNow: 2, FleetNow: 7, Today: 21, Month: 314},
	})
	if len(got.SessionRows) != 4 || got.SessionRows[0].Label != "local procs" || got.SessionRows[0].Count != 2 || got.SessionRows[1].Label != "hosts 30m" || got.SessionRows[2].Label != "syncs UTC day" || got.SessionRows[3].Label != "syncs UTC month" || got.SessionRows[3].Count != 314 {
		t.Fatalf("session rows = %+v", got.SessionRows)
	}
}

func TestBuildFallsBackToLocalClaudePreferencesPerField(t *testing.T) {
	withClaudeVersion(t, "2.1.175")
	t.Setenv("ANTHROPIC_MODEL", "")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte(`{"model":"local-model","effortLevel":"local-effort"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	modelOverride := "wrapper-model"
	got := Build(context.Background(), Inputs{
		Config:         &config.Config{EngineOptions: config.EngineOptions{ClaudeModelOverride: &modelOverride}},
		WrapperVersion: "0.6.44",
		Auth: &orchestrator.AuthRetrieveResponse{Status: "valid", Host: &orchestrator.HostInfo{
			ClaudeModelOverride: "host-model",
			ReasoningEffort:     "host-effort",
		}},
	})
	if got.Model != "wrapper-model" || got.Effort != "host-effort" {
		t.Fatalf("wrapper/host precedence = model %q effort %q", got.Model, got.Effort)
	}

	got = Build(context.Background(), Inputs{
		WrapperVersion: "0.6.44",
		Auth:           &orchestrator.AuthRetrieveResponse{Status: "valid"},
	})
	if got.Model != "local-model" || got.Effort != "local-effort" {
		t.Fatalf("local fallback = model %q effort %q", got.Model, got.Effort)
	}

	t.Setenv("ANTHROPIC_MODEL", "env-model")
	got = Build(context.Background(), Inputs{
		WrapperVersion: "0.6.44",
		Auth: &orchestrator.AuthRetrieveResponse{Status: "valid", Host: &orchestrator.HostInfo{
			ClaudeModelOverride: "host-model",
		}},
	})
	if got.Model != "env-model" || got.Effort != "local-effort" {
		t.Fatalf("runtime env precedence = model %q effort %q", got.Model, got.Effort)
	}
}

func TestBuildHealthFailureOutranksInsecureWarning(t *testing.T) {
	withClaudeVersion(t, "2.1.175")
	got := Build(context.Background(), Inputs{
		Config:         &config.Config{Host: config.Host{Secure: false}},
		WrapperVersion: "0.6.44",
		Auth:           &orchestrator.AuthRetrieveResponse{Status: "invalid", Host: &orchestrator.HostInfo{Secure: false}},
	})
	if got.ResultTone != ui.ToneFail {
		t.Fatalf("insecure warning hid auth failure: tone=%q label=%q dots=%+v", got.ResultTone, got.ResultLabel, got.Dots)
	}
}

func TestBuildForwardsBypassPermissions(t *testing.T) {
	got := Build(context.Background(), Inputs{BypassPermissions: true})
	if !got.BypassPermissions {
		t.Fatalf("BypassPermissions = false, want true")
	}
}

func TestBuildDefaultsBypassPermissionsFalse(t *testing.T) {
	got := Build(context.Background(), Inputs{})
	if got.BypassPermissions {
		t.Fatalf("BypassPermissions = true, want false")
	}
}

func withClaudeVersion(t *testing.T, version string) {
	t.Helper()
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "claude")
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho '"+version+"'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("CLX_CLAUDE_BIN", path)
}
