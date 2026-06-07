package lifecycle

import (
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
)

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
