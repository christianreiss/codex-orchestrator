package codex

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
)

func TestBuildEnvIncludesOverrides(t *testing.T) {
	model := "gpt-5.4"
	effort := "high"
	cfg := &config.Config{
		Orchestrator: config.Orchestrator{
			BaseURL: "https://orch.example.com",
			APIKey:  "sk-codex-abc",
		},
		Host:    config.Host{ID: 1, FQDN: "h.example.com"},
		Wrapper: config.Wrapper{Version: "0.6.0"},
		EngineOptions: config.EngineOptions{
			ModelOverride:           &model,
			ReasoningEffortOverride: &effort,
		},
	}
	env := BuildEnv(cfg)
	have := map[string]bool{}
	for _, kv := range env {
		have[kv] = true
	}
	for _, want := range []string{
		"OPENAI_BASE_URL=https://orch.example.com/v1",
		"OPENAI_API_KEY=sk-codex-abc",
		"CDX_MODEL=gpt-5.4",
		"CDX_REASONING_EFFORT=high",
		"CDX_HOST_FQDN=h.example.com",
		"CDX_HOST_ID=1",
		"CDX_WRAPPER_VERSION=0.6.0",
	} {
		if !have[want] {
			t.Errorf("missing %q", want)
		}
	}
}

func TestRunCaptureReturnsPreExecError(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho should-not-run\n"), 0o755); err != nil {
		t.Fatalf("write fake codex: %v", err)
	}
	t.Setenv("CDX_CODEX_BIN", bin)

	cfg := &config.Config{Host: config.Host{FQDN: "definitely-not-this-host.invalid"}}
	exit, out, err := RunCapture(context.Background(), cfg, []string{"--version"})
	if err == nil {
		t.Fatal("expected preexec FQDN error")
	}
	if exit != 1 {
		t.Fatalf("exit = %d, want 1", exit)
	}
	if len(out) != 0 {
		t.Fatalf("captured output = %q, want empty", string(out))
	}
	if !strings.Contains(err.Error(), "does not match baked FQDN") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestIsWrapperSelf(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Skipf("os.Executable unavailable: %v", err)
	}
	if !isWrapperSelf(self) {
		t.Fatalf("isWrapperSelf(self=%q) = false, want true", self)
	}

	// A symlink pointing at the running binary must resolve back to self so
	// FindCLI can refuse it (the `codex`-shadows-`cdx` recursion guard).
	link := filepath.Join(t.TempDir(), "codex")
	if err := os.Symlink(self, link); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	if !isWrapperSelf(link) {
		t.Fatalf("isWrapperSelf(symlink->self) = false, want true")
	}

	// A genuinely different binary must not be flagged as self.
	for _, other := range []string{"/bin/sh", "/usr/bin/env", "/bin/true"} {
		if _, statErr := os.Stat(other); statErr == nil {
			if isWrapperSelf(other) {
				t.Fatalf("isWrapperSelf(%q) = true, want false", other)
			}
			break
		}
	}
}
