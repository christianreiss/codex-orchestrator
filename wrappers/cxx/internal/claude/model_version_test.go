package claude

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func writeFakeClaude(t *testing.T, bin, version, marker string) {
	t.Helper()
	script := "#!/bin/sh\ncase \"$1\" in --version|-V) echo '" + version + " (Claude Code)';; *) touch '" + marker + "';; esac\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestUnsupportedClaudeModelStopsBeforeAuthAndNativeExecution(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ANTHROPIC_MODEL", "")
	bin := filepath.Join(t.TempDir(), "claude")
	marker := filepath.Join(home, "launched")
	t.Setenv("CLX_CLAUDE_BIN", bin)
	writeFakeClaude(t, bin, "2.1.283", marker)
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o700); err != nil {
		t.Fatal(err)
	}
	settings := []byte(`{"model":"claude-sonnet-5-5[1m]"}`)
	if err := os.WriteFile(settingsPath, settings, 0o600); err != nil {
		t.Fatal(err)
	}
	authPath, err := AuthPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatal(err)
	}
	auth := []byte(`{"test":"preserved"}`)
	if err := os.WriteFile(authPath, auth, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Engine: config.EngineClaude}
	code, _, err := RunCapture(context.Background(), cfg, []string{"-p", "prompt"})
	if code != 2 || err == nil || !strings.Contains(err.Error(), "2.1.284") || !strings.Contains(err.Error(), "clx update") {
		t.Fatalf("code=%d err=%v", code, err)
	}
	if _, statErr := os.Stat(marker); !os.IsNotExist(statErr) {
		t.Fatal("native conversation started")
	}
	if raw, _ := os.ReadFile(authPath); string(raw) != string(auth) {
		t.Fatal("auth changed")
	}
	if raw, _ := os.ReadFile(settingsPath); string(raw) != string(settings) {
		t.Fatal("settings changed")
	}
	// Recovery and diagnostics never select a model.
	for _, args := range [][]string{{"--help"}, {"-v"}, {"--version"}, {"update"}, {"doctor"}, {"auth", "status"}, {"mcp", "list"}, {"install", "stable"}} {
		if err := CheckModelSupport(context.Background(), cfg, args); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	}
	// An explicit older model, a host override or env selection decide instead of settings.
	for _, tc := range []struct {
		args     []string
		env      string
		override string
		refuse   bool
	}{
		{[]string{"--model", "claude-sonnet-5"}, "", "", false},
		{[]string{"--model=sonnet"}, "", "", false},
		{nil, "claude-opus-4-8", "", false},
		{nil, "claude-opus-4-8", "claude-haiku-5-5", true},
		{[]string{"--model", "claude-sonnet-5"}, "", "claude-haiku-5-5", false},
		{[]string{"--settings", `{"model":"claude-sonnet-5"}`}, "", "", false},
		{[]string{"--", "--model", "claude-sonnet-5"}, "", "", true},
	} {
		t.Setenv("ANTHROPIC_MODEL", tc.env)
		cfg := &config.Config{Engine: config.EngineClaude}
		if tc.override != "" {
			override := tc.override
			cfg.EngineOptions.ClaudeModelOverride = &override
		}
		err := CheckModelSupport(context.Background(), cfg, tc.args)
		if (err != nil) != tc.refuse {
			t.Fatalf("%+v: %v", tc, err)
		}
	}
	t.Setenv("ANTHROPIC_MODEL", "")
	writeFakeClaude(t, bin, "2.1.284", marker)
	if err := CheckModelSupport(context.Background(), cfg, []string{"-p", "prompt"}); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeModelSupportFollowsLatestFamilyRewrite(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ANTHROPIC_MODEL", "")
	bin := filepath.Join(t.TempDir(), "claude")
	t.Setenv("CLX_CLAUDE_BIN", bin)
	writeFakeClaude(t, bin, "2.1.283", filepath.Join(home, "launched"))
	cfg := &config.Config{Engine: config.EngineClaude}
	cfg.EngineOptions.ModelPolicy = &config.ModelPolicy{LatestOnly: true, Replacements: map[string]string{"claude-sonnet-5": "claude-sonnet-5-5"}}
	err := CheckModelSupport(context.Background(), cfg, []string{"--model", "claude-sonnet-5[1m]"})
	if err == nil || !strings.Contains(err.Error(), "claude-sonnet-5-5[1m]") {
		t.Fatalf("latest-family choice bypassed the floor: %v", err)
	}
}
