package agentportal

import (
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"testing"
)

func TestSupervisorPinsNativeModelAcrossEngines(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			cfg := &config.Config{EngineOptions: config.EngineOptions{ModelCatalog: &config.ModelCatalog{DefaultModel: "original"}}}
			if got := supervisorModel(cfg, StartInput{Engine: engine}); got != "original" {
				t.Fatal(got)
			}
			for _, args := range [][]string{{"--model", "selected"}, {"--model=selected"}, {"-m", "selected"}} {
				if got := supervisorModel(cfg, StartInput{Engine: engine, NativeArgs: args}); got != "selected" {
					t.Fatal(got)
				}
			}
		})
	}
	if got := supervisorModel(nil, StartInput{}); got != "" {
		t.Fatal("guessed model", got)
	}
}
