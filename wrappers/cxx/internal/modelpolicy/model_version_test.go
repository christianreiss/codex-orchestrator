package modelpolicy

import (
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"os"
	"path/filepath"
	"testing"
)

func TestSelectedModelVersionPrecedenceAndOpaqueValues(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("model='gpt-6-astra'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "review.config.toml"), []byte("model='gpt-6.1-terra'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Engine: "codex"}
	cfg.EngineOptions.ModelPolicy = &config.ModelPolicy{LatestOnly: false}
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"-mgpt-6.1-terra", "exec", "prompt"}, "gpt-6.1-terra"},
		{[]string{"--profile", "review", "exec", "prompt"}, "gpt-6.1-terra"},
		{[]string{"-c", `model="gpt-6.1-terra"`, "exec", "prompt"}, "gpt-6.1-terra"},
		{[]string{"-c", `profile="review"`, "exec", "prompt"}, "gpt-6-astra"},
		{[]string{"--model", "gpt-6.1-terra", "-c", `model="gpt-6-astra"`}, "gpt-6.1-terra"},
		{[]string{"-c", `model="gpt-6-astra"`, "--model", "gpt-6.1-terra"}, "gpt-6.1-terra"},
		{[]string{"--model", "gpt-6-astra", "-c", `model="gpt-6.1-terra"`}, "gpt-6-astra"},
		{[]string{"-c", `model="gpt-6.1-terra"`, "--model", "gpt-6-astra"}, "gpt-6-astra"},
		{[]string{"-p", "review", "--model", "gpt-6.1-terra", "-c", `profiles.review.model="gpt-6-astra"`}, "gpt-6.1-terra"},
		{[]string{"-p", "review", "-c", `profiles.review.model="gpt-6-astra"`}, "gpt-6.1-terra"},
		{[]string{"-c", `profiles.review.model="gpt-6-astra"`, "-p", "review"}, "gpt-6.1-terra"},
		{[]string{"-p", "review", "-c", `profile="ignored"`}, "gpt-6.1-terra"},
		{[]string{"-c", `profile="ignored"`, "-p", "review"}, "gpt-6.1-terra"},
		{[]string{"-p", "review", "-c", `model="gpt-6-astra"`}, "gpt-6-astra"},
		{[]string{"--cd", "--model=gpt-6.1-terra", "exec", "prompt"}, "gpt-6-astra"},
		{[]string{"exec", "--", "--model=gpt-6.1-terra"}, "gpt-6-astra"},
		{[]string{"--model", "gpt-6.1-terra", "--help"}, ""},
		{[]string{"login", "--with-api-key"}, ""},
		{[]string{"features", "list"}, ""},
	} {
		got, err := SelectedModel(cfg, tc.args, home)
		if err != nil || got != tc.want {
			t.Fatalf("%v = %q,%v want %q", tc.args, got, err, tc.want)
		}
	}
	cfg.EngineOptions.ModelPolicy = &config.ModelPolicy{LatestOnly: true, Replacements: map[string]string{"gpt-5.6-terra": "gpt-6.1-terra"}}
	if got, err := SelectedModel(cfg, []string{"--model", "gpt-5.6-terra"}, home); got != "gpt-6.1-terra" || err != nil {
		t.Fatalf("latest = %q,%v", got, err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("model='gpt-6-astra'\nprofile='review'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := SelectedModel(cfg, nil, home); got != "gpt-6-astra" || err != nil {
		t.Fatalf("obsolete root profile changed selection %q,%v", got, err)
	}
	if err := os.Remove(filepath.Join(home, "config.toml")); err != nil {
		t.Fatal(err)
	}
	if got, err := SelectedModel(cfg, []string{"-p", "review"}, home); got != "gpt-6.1-terra" || err != nil {
		t.Fatalf("sidecar without root = %q,%v", got, err)
	}
}
