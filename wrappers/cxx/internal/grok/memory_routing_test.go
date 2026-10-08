package grok

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/memoryrouting"
)

func TestMemoryRemindersReachIsolatedRuntime(t *testing.T) {
	r, pool := runtimeFixture(t)
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := memoryrouting.Apply("grok", r.BaseHome, &memoryrouting.Bundle{Enabled: true, Content: "shared_memory_search central memory"}, nil); err != nil {
		t.Fatal(err)
	}
	r, err := NewRuntime(r.BaseHome, &config.Config{}, nil, pool)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	for _, path := range []string{filepath.Join("memory", "MEMORY.md"), filepath.Join("memory-v2", "global", "MEMORY.md"), filepath.Join("memory-v2", "global", "topics", "cxx-memory-routing.md")} {
		body, err := os.ReadFile(filepath.Join(r.Home, path))
		if err != nil || !strings.Contains(string(body), "shared_memory_search") {
			t.Fatalf("runtime reminder missing at %s: %v", path, err)
		}
	}
}
