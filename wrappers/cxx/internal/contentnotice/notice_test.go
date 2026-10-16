package contentnotice

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func isolate(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	t.Setenv("GROK_HOME", "")
	return home
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestUnchangedPassPublishesNothing(t *testing.T) {
	home := isolate(t)
	agents := filepath.Join(home, ".codex", "AGENTS.md")
	write(t, agents, "same")
	kinds := map[string][]string{KindInstructions: {agents}, KindSkills: {filepath.Join(home, "missing")}}
	if err := PublishChanges("codex", agents, Capture(kinds), Capture(kinds)); err != nil {
		t.Fatal(err)
	}
	if notice, err := Consume("codex", "session"); err != nil || notice != nil {
		t.Fatalf("unchanged pass published: %+v %v", notice, err)
	}
}

func TestChangedKindsReachEachSessionOnce(t *testing.T) {
	home := isolate(t)
	agents := filepath.Join(home, ".claude", "CLAUDE.md")
	skills := filepath.Join(home, ".claude", "skills")
	write(t, agents, "old")
	kinds := map[string][]string{KindInstructions: {agents}, KindSkills: {skills}, KindConfig: {filepath.Join(home, ".claude", "settings.json")}}
	before := Capture(kinds)
	write(t, agents, "new")
	write(t, filepath.Join(skills, "demo", "SKILL.md"), "skill")
	if err := PublishChanges("claude", agents, before, Capture(kinds)); err != nil {
		t.Fatal(err)
	}
	for _, session := range []string{"first", "second"} {
		notice, err := Consume("claude", session)
		if err != nil || notice == nil {
			t.Fatalf("%s: missing notice: %v", session, err)
		}
		message := notice.Message()
		if !strings.Contains(message, agents) || !strings.Contains(message, "skill_list") || strings.Contains(message, "next launch") {
			t.Fatalf("unexpected message: %s", message)
		}
		if again, err := Consume("claude", session); err != nil || again != nil {
			t.Fatalf("%s: notice repeated: %+v %v", session, again, err)
		}
	}
}

func TestPrimedSessionSkipsEarlierPassButSeesLaterOne(t *testing.T) {
	home := isolate(t)
	agents := filepath.Join(home, ".grok", "AGENTS.md")
	kinds := map[string][]string{KindInstructions: {agents}}
	before := Capture(kinds)
	write(t, agents, "one")
	if err := PublishChanges("grok", agents, before, Capture(kinds)); err != nil {
		t.Fatal(err)
	}
	if err := Prime("grok", "fresh"); err != nil {
		t.Fatal(err)
	}
	if notice, _ := Consume("grok", "fresh"); notice != nil {
		t.Fatal("primed session received content it launched with")
	}
	before = Capture(kinds)
	write(t, agents, "two")
	if err := PublishChanges("grok", agents, before, Capture(kinds)); err != nil {
		t.Fatal(err)
	}
	if notice, err := Consume("grok", "fresh"); err != nil || notice == nil {
		t.Fatalf("later change lost: %v", err)
	}
}

func TestUnreadKindsMergeIntoNewerNotice(t *testing.T) {
	home := isolate(t)
	agents := filepath.Join(home, ".codex", "AGENTS.md")
	digest := filepath.Join(home, ".cache", "skills-digest")
	kinds := map[string][]string{KindInstructions: {agents}, KindSkills: {digest}}
	before := Capture(kinds)
	write(t, agents, "rules")
	if err := PublishChanges("codex", agents, before, Capture(kinds)); err != nil {
		t.Fatal(err)
	}
	before = Capture(kinds)
	write(t, digest, "skills")
	if err := PublishChanges("codex", agents, before, Capture(kinds)); err != nil {
		t.Fatal(err)
	}
	notice, err := Consume("codex", "idle")
	if err != nil || notice == nil || len(notice.Kinds) != 2 {
		t.Fatalf("earlier kind lost: %+v %v", notice, err)
	}
}

func TestAbortedDeliveryStaysPending(t *testing.T) {
	home := isolate(t)
	agents := filepath.Join(home, ".codex", "AGENTS.md")
	kinds := map[string][]string{KindInstructions: {agents}}
	before := Capture(kinds)
	write(t, agents, "x")
	if err := PublishChanges("codex", agents, before, Capture(kinds)); err != nil {
		t.Fatal(err)
	}
	delivery, err := Prepare("codex", "session")
	if err != nil || delivery == nil {
		t.Fatalf("prepare: %v", err)
	}
	if other, err := Prepare("codex", "session"); err == nil || other != nil {
		t.Fatal("competing consumer acquired delivery")
	}
	delivery.Abort()
	if retry, err := Consume("codex", "session"); err != nil || retry == nil {
		t.Fatalf("failed write swallowed notice: %v", err)
	}
}
