package summary

import (
	"context"
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
