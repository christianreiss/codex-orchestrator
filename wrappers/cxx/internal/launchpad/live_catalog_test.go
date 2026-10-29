package launchpad

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func liveCatalogConfig() *config.Config {
	medium := "medium"
	return signed([]string{"codex"}, &config.ModelCatalog{
		DefaultModel: "gpt-6-astra",
		Models:       []config.ModelCatalogEntry{{Model: "gpt-6-astra"}, {Model: "gpt-6-luna", Efforts: []string{"low", "medium"}, DefaultEffort: &medium}},
		LiveCatalogModels: []config.ModelCatalogEntry{
			{Model: "gpt-6.1-luna", Efforts: []string{"low", "medium", "high", "xhigh", "max"}, DefaultEffort: &medium},
		},
	})
}

func TestLiveCatalogModelsNeedTheHostCatalog(t *testing.T) {
	for _, tc := range []struct {
		name    string
		live    func(string) map[string]bool
		offered bool
	}{
		{"cache lists it", func(string) map[string]bool { return map[string]bool{"gpt-6.1-luna": true, "gpt-6-luna": true} }, true},
		{"cache lacks it", func(string) map[string]bool { return map[string]bool{"gpt-6-luna": true} }, false},
		{"no cache", func(string) map[string]bool { return nil }, false},
		{"no reader", nil, false},
	} {
		models := menu("codex", liveCatalogConfig(), Sources{LiveModels: tc.live})
		m, ok := findModel(models, "gpt-6.1-luna")
		if ok != tc.offered {
			t.Fatalf("%s: offered=%v, menu %#v", tc.name, ok, models)
		}
		if ok && (m.DefaultEffort != "medium" || len(m.Efforts) != 5 || m.Unavailable != "") {
			t.Fatalf("%s: wrong entry %#v", tc.name, m)
		}
		// Verified models never depend on the host catalog.
		if _, ok := findModel(models, "gpt-6-astra"); !ok {
			t.Fatalf("%s: verified model hidden", tc.name)
		}
		if models[len(models)-1].ID != map[bool]string{true: "gpt-6.1-luna", false: "gpt-6-luna"}[tc.offered] {
			t.Fatalf("%s: unverified model must follow the verified menu: %#v", tc.name, models)
		}
	}
}

func TestHiddenLiveCatalogSelectionFallsBackToDefault(t *testing.T) {
	src := Sources{
		LiveModels: func(string) map[string]bool { return nil },
		Last:       &Selection{Engine: "codex", Model: "gpt-6.1-luna", Effort: "high"},
	}
	cfg := liveCatalogConfig()
	model, _ := start("codex", cfg, menu("codex", cfg, src), src)
	if model != "gpt-6-astra" {
		t.Fatalf("hidden unverified selection kept: %s", model)
	}
}

func TestCodexCatalogModelsReadsListedSlugs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "models_cache.json")
	if got := codexCatalogModels(path); got != nil {
		t.Fatalf("missing cache must be unknown, got %v", got)
	}
	if err := os.WriteFile(path, []byte(`{"client_version":"0.165.0","models":[{"slug":"gpt-6-luna","visibility":"list"},{"slug":"gpt-reserve","visibility":"hide"},{"slug":" gpt-6.1-luna ","visibility":"list"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got := codexCatalogModels(path)
	if !got["gpt-6-luna"] || !got["gpt-6.1-luna"] || got["gpt-reserve"] || len(got) != 2 {
		t.Fatalf("unexpected listed set %v", got)
	}
	if err := os.WriteFile(path, []byte(`{not json`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := codexCatalogModels(path); got != nil {
		t.Fatalf("malformed cache must be unknown, got %v", got)
	}
	t.Setenv("CODEX_HOME", dir)
	if got := LocalLiveModels("claude"); got != nil {
		t.Fatalf("claude keeps no live catalog, got %v", got)
	}
}
