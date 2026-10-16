package lifecycle

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

func TestClaudeSkillsMCPMigrationAndNativeFallback(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	ctx := context.Background()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	root := claudeSubdir("skills")
	userSkill := filepath.Join(root, "personal", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(userSkill), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(userSkill, []byte("personal skill"), 0644); err != nil {
		t.Fatal(err)
	}
	bundle := []orchestrator.CollectionItem{skillItem("fleet", "1", "fleet instructions")}
	if got := applyBundleClaudeSkills(ctx, bundle, logger); got.Err != nil || !got.Checked || !got.Updated {
		t.Fatalf("native install = %+v", got)
	}
	// The API sends [] when MCP is available. This retires tracked native copies.
	if got := applyBundleClaudeSkills(ctx, []orchestrator.CollectionItem{}, logger); got.Err != nil || !got.Checked || !got.Updated {
		t.Fatalf("MCP migration = %+v", got)
	}
	if _, err := os.Stat(filepath.Join(root, "fleet")); !os.IsNotExist(err) {
		t.Fatalf("fleet directory survived MCP migration: %v", err)
	}
	if len(skillDigestsForRequest()) != 0 {
		t.Fatal("retired skills still advertised as installed")
	}
	if got := applyBundleClaudeSkills(ctx, []orchestrator.CollectionItem{}, logger); got.Err != nil || !got.Checked || got.Updated {
		t.Fatalf("repeated MCP sync = %+v", got)
	}
	// Disabling MCP causes the complete native fallback bundle to be sent again.
	if got := applyBundleClaudeSkills(ctx, bundle, logger); got.Err != nil || !got.Checked || !got.Updated {
		t.Fatalf("native fallback = %+v", got)
	}
	if !fileExists(filepath.Join(root, "fleet", "SKILL.md")) {
		t.Fatal("native fallback was not restored")
	}
	if raw, err := os.ReadFile(userSkill); err != nil || string(raw) != "personal skill" {
		t.Fatalf("user-owned skill changed: %q, %v", raw, err)
	}
}
