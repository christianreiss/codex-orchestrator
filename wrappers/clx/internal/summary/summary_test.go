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
