package authnotice

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func generation(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func TestAbortedDeliveryRetriesAndOlderAcknowledgementDoesNotHideNewUpdate(t *testing.T) {
	isolate(t)
	if err := Publish("codex", generation("first")); err != nil {
		t.Fatal(err)
	}
	delivery, err := Prepare("codex", "session")
	if err != nil || delivery == nil {
		t.Fatalf("prepare: %v %v", delivery, err)
	}
	if other, err := Prepare("codex", "session"); err == nil || other != nil {
		t.Fatal("competing consumer acquired delivery")
	}
	delivery.Abort()
	retry, err := Prepare("codex", "session")
	if err != nil || retry == nil {
		t.Fatalf("failed write swallowed notice: %v %v", retry, err)
	}
	if err := Publish("codex", generation("second")); err != nil {
		t.Fatal("delivery blocked publisher", err)
	}
	if err := retry.Commit(); err != nil {
		t.Fatal(err)
	}
	next, err := Consume("codex", "session")
	if err != nil || next == nil || next.Generation != generation("second") {
		t.Fatalf("old acknowledgement hid new generation: %v %v", next, err)
	}
}

func TestPublicationRetriesBriefReaderContention(t *testing.T) {
	isolate(t)
	locked := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan error, 1)
	go func() { finished <- withLock("claude", func(string) error { close(locked); <-release; return nil }) }()
	<-locked
	result := make(chan error, 1)
	go func() { result <- Publish("claude", generation("new")) }()
	time.Sleep(12 * time.Millisecond)
	close(release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatalf("short reader contention lost update: %v", err)
	}
	if n, err := Consume("claude", "session"); err != nil || n == nil {
		t.Fatalf("missing published update: %v %v", n, err)
	}
}
func isolate(t *testing.T) { t.Helper(); t.Setenv("HOME", t.TempDir()); t.Setenv("CODEX_HOME", "") }

func TestEachEngineAndSessionReceivesAdoptionOnce(t *testing.T) {
	isolate(t)
	for _, engine := range []string{"codex", "claude"} {
		if err := Publish(engine, generation("first")); err != nil {
			t.Fatal(err)
		}
		for _, session := range []string{"session-one", "session-two"} {
			notice, err := Consume(engine, session)
			if err != nil || notice == nil || notice.Engine != engine {
				t.Fatalf("%s %s: %v %v", engine, session, notice, err)
			}
			if strings.Contains(notice.Message(), notice.Generation) {
				t.Fatal("notice exposes credential fingerprint")
			}
			again, err := Consume(engine, session)
			if err != nil || again != nil {
				t.Fatalf("duplicate: %v %v", again, err)
			}
		}
	}
	if err := Publish("claude", generation("second")); err != nil {
		t.Fatal(err)
	}
	if n, err := Consume("codex", "session-one"); err != nil || n != nil {
		t.Fatalf("Claude event leaked into Codex: %v %v", n, err)
	}
	if n, err := Consume("claude", "session-one"); err != nil || n == nil {
		t.Fatalf("missed next Claude generation: %v %v", n, err)
	}
}

func TestPrimeAndRepublishNeverRepeatOldEvent(t *testing.T) {
	isolate(t)
	if err := Publish("codex", generation("before")); err != nil {
		t.Fatal(err)
	}
	if err := Prime("codex", "new-session"); err != nil {
		t.Fatal(err)
	}
	if err := Publish("codex", generation("before")); err != nil {
		t.Fatal(err)
	}
	if n, err := Consume("codex", "new-session"); err != nil || n != nil {
		t.Fatalf("old event: %v %v", n, err)
	}
	if err := Publish("codex", generation("during")); err != nil {
		t.Fatal(err)
	}
	if n, err := Consume("codex", "new-session"); err != nil || n == nil {
		t.Fatalf("missing active event: %v %v", n, err)
	}
}

func TestCustomCodexHomeScopesNotifications(t *testing.T) {
	isolate(t)
	if err := Publish("codex", generation("default")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", t.TempDir())
	if n, err := Consume("codex", "session"); err != nil || n != nil {
		t.Fatalf("foreign account notice: %v %v", n, err)
	}
}

func TestNoticeRejectsUntrustedIdentifiersAndMalformedState(t *testing.T) {
	isolate(t)
	if err := Publish("../claude", generation("x")); err == nil {
		t.Fatal("unsafe engine accepted")
	}
	if err := Publish("claude", "a token must never be stored here"); err == nil {
		t.Fatal("non-generation accepted")
	}
	if _, err := Consume("claude", "../session"); err == nil {
		t.Fatal("unsafe session accepted")
	}
	dir, _ := paths("claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "current.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if n, err := Consume("claude", "session"); err == nil || n != nil {
		t.Fatalf("corrupt notice: %v %v", n, err)
	}
}

func TestNoticeFilesArePrivate(t *testing.T) {
	isolate(t)
	if err := Publish("claude", generation("private")); err != nil {
		t.Fatal(err)
	}
	if _, err := Consume("claude", "session"); err != nil {
		t.Fatal(err)
	}
	dir, _ := paths("claude")
	for _, name := range []string{"current.json", "session.seen", ".lock"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode=%v", name, info.Mode().Perm())
		}
	}
}
