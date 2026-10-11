package lifecycle

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/atomicdir"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

func TestClaudeSkillPublicationSurvivesKilledWriter(t *testing.T) {
	const phaseKey = "CXX_CLAUDE_SKILL_CRASH_PHASE"
	skill := item("sample", collectionFileDigest("new skill"), "new skill")
	if phase := os.Getenv(phaseKey); phase != "" {
		publishSkillBundle = func(stage, target string, replace bool) error {
			if phase != "prepared" {
				if err := atomicdir.Publish(stage, target, replace); err != nil {
					return err
				}
			}
			_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
			select {}
		}
		_, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{skill}, slog.Default())
		t.Fatalf("writer was not killed: %v", err)
	}
	for _, phase := range []string{"published", "strip", "replacement", "prepared"} {
		t.Run(phase, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			if phase == "replacement" {
				old := item("sample", collectionFileDigest("old skill"), "old skill")
				if _, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{old}, slog.Default()); err != nil {
					t.Fatal(err)
				}
			}
			cmd := exec.Command(os.Args[0], "-test.run=^TestClaudeSkillPublicationSurvivesKilledWriter$")
			cmd.Env = append(os.Environ(), phaseKey+"="+phase)
			out, err := cmd.CombinedOutput()
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) {
				t.Fatalf("writer did not exit by signal: %v %s", err, out)
			}
			status, ok := exitErr.Sys().(syscall.WaitStatus)
			if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
				t.Fatalf("expected SIGKILL: %v %s", err, out)
			}
			if !fileExists(collectionManifestPath("skills") + ".pending") {
				t.Fatal("missing durable publication intent")
			}
			target := filepath.Join(claudeSubdir("skills"), "sample", "SKILL.md")
			if phase == "strip" {
				if err := stripClaudeSkills(slog.Default()); err != nil {
					t.Fatal(err)
				}
				if _, err := os.Stat(target); !os.IsNotExist(err) {
					t.Fatalf("orphan escaped trust-loss cleanup: %v", err)
				}
			} else {
				if _, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{skill}, slog.Default()); err != nil {
					t.Fatal("orphan not recovered:", err)
				}
				raw, err := os.ReadFile(target)
				if err != nil || string(raw) != skill.Content {
					t.Fatalf("skill = %q, %v", raw, err)
				}
				if skillDigestsForRequest()["sample"] != skill.SHA256 {
					t.Fatal("ownership not repaired")
				}
			}
			stages, err := filepath.Glob(filepath.Join(claudeSubdir("skills"), ".sample.new-*"))
			if err != nil || len(stages) != 0 {
				t.Fatalf("staging leftovers: %v %v", stages, err)
			}
		})
	}
}

func TestClaudeSkillJournalNeverAdoptsSameContentUserDirectory(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	originalPublish := publishSkillBundle
	t.Cleanup(func() { publishSkillBundle = originalPublish })
	skill := item("sample", collectionFileDigest("fleet"), "fleet")
	publishSkillBundle = func(stage, target string, replace bool) error {
		if replace {
			t.Fatal("unowned directory replacement was authorized")
		}
		if err := os.Mkdir(target, 0755); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(target, "SKILL.md"), []byte(skill.Content), 0644); err != nil {
			return err
		}
		return atomicdir.Publish(stage, target, replace)
	}
	if _, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{skill}, slog.Default()); err == nil {
		t.Fatal("foreign directory replaced")
	}
	publishSkillBundle = originalPublish
	if _, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{skill}, slog.Default()); err == nil {
		t.Fatal("same-content user directory adopted")
	}
	if len(loadManifest(collectionManifestPath("skills")).Items) != 0 {
		t.Fatal("foreign ownership recorded")
	}
	target := filepath.Join(claudeSubdir("skills"), "sample", "SKILL.md")
	if err := stripClaudeSkills(slog.Default()); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(target)
	if err != nil || string(raw) != "fleet" {
		t.Fatalf("user skill = %q, %v", raw, err)
	}
}

func TestClaudeSkillPublicationSerializesSyncAndTrustLoss(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	skill := item("sample", collectionFileDigest("fleet"), "fleet")
	if _, err := applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{skill}, slog.Default()); err != nil {
		t.Fatal(err)
	}
	lease, err := ipc.TryAcquireExclusivePath(collectionManifestPath("skills") + ".lock")
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if _, err = applyClaudeSkillsResult(context.Background(), []orchestrator.CollectionItem{}, slog.Default()); !errors.Is(err, ipc.ErrHeld) {
		t.Fatalf("competing sync was not rejected: %v", err)
	}
	if err = stripClaudeSkills(slog.Default()); !errors.Is(err, ipc.ErrHeld) {
		t.Fatalf("competing trust-loss cleanup was not rejected: %v", err)
	}
	if !fileExists(filepath.Join(claudeSubdir("skills"), "sample", "SKILL.md")) {
		t.Fatal("active writer lost its directory")
	}
}
