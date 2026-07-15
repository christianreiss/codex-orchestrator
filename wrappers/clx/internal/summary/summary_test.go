package summary

import (
	"context"
	"os"
	"path/filepath"
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
