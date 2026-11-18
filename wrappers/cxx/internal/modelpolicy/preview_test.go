package modelpolicy_test

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/modelpolicy"
)

func TestPreviewReportsRewriteSilentlyAndAnnouncementQuietsApply(t *testing.T) {
	t.Cleanup(modelpolicy.ResetAnnounced)
	home := t.TempDir()
	body := "model='gpt-6.1-sol'\nmodel_reasoning_effort='high'\n"
	os.WriteFile(filepath.Join(home, "config.toml"), []byte(body), 0600)
	cfg := fixture("codex", "gpt-6.1-sol", "gpt-6.2-sol")

	from, to := modelpolicy.Preview(cfg, nil, home, nil, modelpolicy.Preferences{})
	if from != "gpt-6.1-sol" || to != "gpt-6.2-sol" {
		t.Fatalf("preview = %q → %q", from, to)
	}
	if from, _ := modelpolicy.Preview(cfg, []string{"--model", "gpt-6.2-sol"}, home, nil, modelpolicy.Preferences{}); from != "" {
		t.Fatalf("kept model reported a rewrite from %q", from)
	}

	modelpolicy.MarkAnnounced()
	var notice bytes.Buffer
	got, err := modelpolicy.Apply(cfg, nil, home, nil, &notice)
	if err != nil || len(got) < 2 || got[1] != "gpt-6.2-sol" {
		t.Fatalf("apply = %q, %v", got, err)
	}
	if notice.Len() != 0 {
		t.Fatalf("announced rewrite printed again: %q", notice.String())
	}
}

func TestPreviewNeverWritesKimiRuntimeConfig(t *testing.T) {
	home := t.TempDir()
	body := "default_model='k3'\n[thinking]\neffort='high'\n"
	path := filepath.Join(home, "config.toml")
	os.WriteFile(path, []byte(body), 0600)
	if from, to := modelpolicy.Preview(fixture("kimi", "k3", "k3.1-pro"), []string{"-p", "x"}, home, nil, modelpolicy.Preferences{}); from != "k3" || to != "k3.1-pro" {
		t.Fatalf("preview = %q → %q", from, to)
	}
	if raw, _ := os.ReadFile(path); string(raw) != body {
		t.Fatalf("preview rewrote config: %s", raw)
	}
}
