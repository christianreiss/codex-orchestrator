package summary

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/ui"
)

func TestBuildHidesOlderCodexTargetWhenExactIsFalse(t *testing.T) {
	withCodexVersion(t, "0.130.0")
	target := "0.129.0"
	got := Build(context.Background(), Inputs{
		Auth: &orchestrator.AuthRetrieveResponse{
			Versions: &orchestrator.VersionSummary{
				ClientVersion:             &target,
				ClientVersionEnforceExact: false,
			},
		},
	})

	if got.CodexTarget != "" {
		t.Fatalf("CodexTarget = %q, want empty", got.CodexTarget)
	}
	if got.CodexTone != ui.ToneOK {
		t.Fatalf("CodexTone = %q, want ok", got.CodexTone)
	}
}

func TestBuildShowsNewerCodexTargetWhenExactIsFalse(t *testing.T) {
	withCodexVersion(t, "0.129.0")
	target := "0.130.0"
	got := Build(context.Background(), Inputs{
		Auth: &orchestrator.AuthRetrieveResponse{
			Versions: &orchestrator.VersionSummary{
				ClientVersion:             &target,
				ClientVersionEnforceExact: false,
			},
		},
	})

	if got.CodexTarget != target {
		t.Fatalf("CodexTarget = %q, want %q", got.CodexTarget, target)
	}
	if got.CodexTone != ui.ToneWarn {
		t.Fatalf("CodexTone = %q, want warn", got.CodexTone)
	}
}

func TestBuildShowsOlderCodexTargetWhenExactIsTrue(t *testing.T) {
	withCodexVersion(t, "0.130.0")
	target := "0.129.0"
	got := Build(context.Background(), Inputs{
		Auth: &orchestrator.AuthRetrieveResponse{
			Versions: &orchestrator.VersionSummary{
				ClientVersion:             &target,
				ClientVersionEnforceExact: true,
			},
		},
	})

	if got.CodexTarget != target {
		t.Fatalf("CodexTarget = %q, want %q", got.CodexTarget, target)
	}
	if got.CodexTone != ui.ToneWarn {
		t.Fatalf("CodexTone = %q, want warn", got.CodexTone)
	}
}

func withCodexVersion(t *testing.T, version string) {
	t.Helper()
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "codex")
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho '"+version+"'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("CDX_CODEX_BIN", path)
}

func TestQuotaProjectionNoteShowsPercentAtReset(t *testing.T) {
	got := quotaProjectionNote(24, int64(5*3600), int64(2*3600+27*60))
	if got != "~47% at reset" {
		t.Fatalf("quotaProjectionNote() = %q, want %q", got, "~47% at reset")
	}
}

func TestQuotaProjectionNoteKeepsTimeToFullWhenCrossingLimit(t *testing.T) {
	got := quotaProjectionNote(50, int64(5*3600), int64(4*3600))
	if got != "~250% at reset; 100% in 1h" {
		t.Fatalf("quotaProjectionNote() = %q, want %q", got, "~250% at reset; 100% in 1h")
	}
}

func TestQuotaProjectionNoteSkipsFreshWindow(t *testing.T) {
	if got := quotaProjectionNote(5, int64(5*3600), int64(5*3600)); got != "" {
		t.Fatalf("quotaProjectionNote() = %q, want empty", got)
	}
}
