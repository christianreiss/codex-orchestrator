package contentnotice

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
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

func TestLaterChangesDoNotRepeatSeenKinds(t *testing.T) {
	home := isolate(t)
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			agents := filepath.Join(home, engine, "AGENTS.md")
			skills := filepath.Join(home, engine, "skills-digest")
			config := filepath.Join(home, engine, "config")
			kinds := map[string][]string{KindInstructions: {agents}, KindSkills: {skills}, KindConfig: {config}}
			before := Capture(kinds)
			write(t, agents, "policy one")
			write(t, skills, "skills one")
			after := Capture(kinds)
			if err := PublishChanges(engine, agents, before, after); err != nil {
				t.Fatal(err)
			}
			first, err := Consume(engine, "active")
			if err != nil || first == nil {
				t.Fatalf("initial notice: %+v %v", first, err)
			}
			if message := first.Message(); !strings.Contains(message, first.Generation) || !strings.Contains(message, after[KindInstructions]) || !strings.Contains(message, after[KindSkills]) || !strings.Contains(message, "Changed:") {
				t.Fatalf("missing version or summary: %s", message)
			}
			before = after
			write(t, config, "config two")
			if err := PublishChanges(engine, agents, before, Capture(kinds)); err != nil {
				t.Fatal(err)
			}
			later, err := Consume(engine, "active")
			if err != nil || later == nil || len(later.Kinds) != 1 || later.Kinds[0] != KindConfig {
				t.Fatalf("seen categories repeated: %+v %v", later, err)
			}
			if message := later.Message(); strings.Contains(message, "Re-read") || strings.Contains(message, "skill_list") {
				t.Fatalf("unnecessary reread: %s", message)
			}
			idle, err := Consume(engine, "idle")
			if err != nil || idle == nil || len(idle.Kinds) != 3 {
				t.Fatalf("idle session lost pending categories: %+v %v", idle, err)
			}
			if again, err := Consume(engine, "active"); err != nil || again != nil {
				t.Fatalf("unchanged notice repeated: %+v %v", again, err)
			}
		})
	}
}

func TestCategoryMetadataKeepsLegacyLedgerCompatible(t *testing.T) {
	home := isolate(t)
	agents := filepath.Join(home, "AGENTS.md")
	config := filepath.Join(home, "settings.json")
	kinds := map[string][]string{KindInstructions: {agents}, KindConfig: {config}}
	before := Capture(kinds)
	write(t, agents, "policy")
	if err := PublishChanges("claude", agents, before, Capture(kinds)); err != nil {
		t.Fatal(err)
	}
	notice, err := Consume("claude", "session")
	if err != nil || notice == nil {
		t.Fatalf("notice: %+v %v", notice, err)
	}
	dir, _ := paths("claude")
	ledger := filepath.Join(dir, "session.seen")
	seen, err := os.ReadFile(ledger)
	if err != nil || string(seen) != notice.Generation {
		t.Fatalf("legacy ledger changed format: %q %v", seen, err)
	}
	// Simulate an older consumer having acknowledged a different generation
	// without updating the companion metadata. Its fingerprints are unknown.
	write(t, ledger, strings.Repeat("a", 64))
	before = Capture(kinds)
	write(t, config, "settings")
	if err := PublishChanges("claude", agents, before, Capture(kinds)); err != nil {
		t.Fatal(err)
	}
	notice, err = Consume("claude", "session")
	if err != nil || notice == nil || len(notice.Kinds) != 2 {
		t.Fatalf("stale legacy metadata suppressed pending changes: %+v %v", notice, err)
	}
}

func TestPrimeDoesNotNeedPublisherLock(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			isolate(t)
			if err := Publish(Notice{Generation: strings.Repeat("a", 64), Engine: engine, Kinds: []string{KindInstructions}}); err != nil {
				t.Fatal(err)
			}
			err := withLock(engine, func(dir string) error { return Prime(engine, "fresh") })
			if err != nil {
				t.Fatalf("startup baseline lost under publisher contention: %v", err)
			}
			if n, err := Consume(engine, "fresh"); err != nil || n != nil {
				t.Fatalf("historical notice replayed: %+v %v", n, err)
			}
		})
	}
}

func TestPrimePinsBaselineAndPreservesConcurrentPublication(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			isolate(t)
			baseline := Notice{Generation: strings.Repeat("a", 64), Engine: engine, Kinds: []string{KindInstructions}, Digests: Snapshot{KindInstructions: "old"}}
			if err := Publish(baseline); err != nil {
				t.Fatal(err)
			}
			delivery, err := preparePrime(engine, "fresh")
			if err != nil || delivery == nil {
				t.Fatalf("prepare: %v", err)
			}
			defer delivery.Abort()
			// A new pass can publish after the activation baseline but before its ledger commit.
			later := Notice{Generation: strings.Repeat("b", 64), Engine: engine, Kinds: []string{KindInstructions}, Digests: Snapshot{KindInstructions: "new"}}
			if err := Publish(later); err != nil {
				t.Fatal(err)
			}
			if err := delivery.Commit(); err != nil {
				t.Fatal(err)
			}
			notice, err := Consume(engine, "fresh")
			if err != nil || notice == nil || notice.Generation != later.Generation {
				t.Fatalf("later publication lost: %+v %v", notice, err)
			}
			if again, err := Consume(engine, "fresh"); err != nil || again != nil {
				t.Fatalf("notice replayed: %+v %v", again, err)
			}
		})
	}
}

func TestPrimeFailsImmediatelyOnSessionContention(t *testing.T) {
	isolate(t)
	if err := Publish(Notice{Generation: strings.Repeat("a", 64), Engine: "codex", Kinds: []string{KindSkills}}); err != nil {
		t.Fatal(err)
	}
	delivery, err := preparePrime("codex", "fresh")
	if err != nil || delivery == nil {
		t.Fatalf("prepare: %v", err)
	}
	defer delivery.Abort()
	started := time.Now()
	err = Prime("codex", "fresh")
	if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN {
		t.Fatalf("expected session contention: %v", err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("Prime blocked startup")
	}
	delivery.Abort()
	if n, err := Consume("codex", "fresh"); err != nil || n == nil {
		t.Fatalf("failed prime discarded notice: %+v %v", n, err)
	}
}
