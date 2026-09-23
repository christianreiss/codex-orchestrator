package maintenance

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCoordinatorCoalescesAndRetries(t *testing.T) {
	dir, now := t.TempDir(), time.Now().UTC()
	run, err := beginAt(dir, true, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := beginAt(dir, false, now); !errors.Is(err, ErrBusy) {
		t.Fatalf("manual overlap: %v", err)
	}
	called := false
	if err := requestAt(dir, now, false, func() error { called = true; return nil }); err != nil || called {
		t.Fatalf("launch overlapped run: %v, %v", called, err)
	}
	if err := run.finishAt(errors.New("secret provider detail"), now); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "maintenance.json"))
	if strings.Contains(string(raw), "secret") {
		t.Fatal("failure text persisted")
	}
	if _, err := beginAt(dir, true, now.Add(4*time.Minute)); !errors.Is(err, ErrNotDue) {
		t.Fatalf("retry too early: %v", err)
	}
	run, err = beginAt(dir, true, now.Add(retryInterval))
	if err != nil {
		t.Fatal(err)
	}
	if err := run.finishAt(nil, now.Add(retryInterval)); err != nil {
		t.Fatal(err)
	}
	if _, err := beginAt(dir, true, now.Add(19*time.Minute)); !errors.Is(err, ErrNotDue) {
		t.Fatalf("success cooldown: %v", err)
	}
	run, err = beginAt(dir, false, now.Add(6*time.Minute))
	if err != nil {
		t.Fatalf("manual run must bypass cooldown: %v", err)
	}
	defer run.Finish(nil)
}

func TestQueueSpawnsAfterReleasingCoordinatorLease(t *testing.T) {
	dir, now := t.TempDir(), time.Now().UTC()
	var child *Run
	count := 0
	start := func() error {
		count++
		var err error
		child, err = beginAt(dir, true, now)
		return err
	}
	if err := requestAt(dir, now, false, start); err != nil {
		t.Fatal(err)
	}
	defer child.Finish(nil)
	if err := requestAt(dir, now, false, start); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("spawned %d children", count)
	}
}

func TestQueueRecoversMissingAndCrashedChild(t *testing.T) {
	dir, now := t.TempDir(), time.Now().UTC()
	count := 0
	start := func() error { count++; return nil }
	for _, at := range []time.Time{now, now.Add(time.Second), now.Add(queueInterval)} {
		if err := requestAt(dir, at, false, start); err != nil {
			t.Fatal(err)
		}
	}
	if count != 2 {
		t.Fatalf("stale queued child did not recover: %d", count)
	}
	run, err := beginAt(dir, true, now.Add(queueInterval))
	if err != nil {
		t.Fatal(err)
	}
	// Process death releases flock without calling Finish.
	_ = run.lock.Release()
	if _, err := beginAt(dir, true, now.Add(time.Minute)); !errors.Is(err, ErrNotDue) {
		t.Fatalf("crash retry: %v", err)
	}
	run, err = beginAt(dir, true, now.Add(queueInterval+retryInterval))
	if err != nil {
		t.Fatal(err)
	}
	defer run.Finish(nil)
}

func TestSpawnFailureIsBoundedAndRetryable(t *testing.T) {
	dir, now := t.TempDir(), time.Now().UTC()
	failure := errors.New("no executable")
	if err := requestAt(dir, now, false, func() error { return failure }); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	count := 0
	start := func() error { count++; return nil }
	if err := requestAt(dir, now.Add(time.Minute), false, start); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("failed spawn retried on next launch")
	}
	if err := requestAt(dir, now.Add(retryInterval), false, start); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("failed spawn never retried")
	}
}

func TestStateCorruptionAndClockCorrectionRecover(t *testing.T) {
	for _, raw := range []string{"{broken", `{"next_attempt":"2999-01-01T00:00:00Z"}`} {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "maintenance.json"), []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		run, err := beginAt(dir, true, time.Now().UTC())
		if err != nil {
			t.Fatal(err)
		}
		if err := run.Finish(nil); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Begin(ctx, false); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestChildEnvironmentPreservesScopeWithoutReexecMarkers(t *testing.T) {
	env, err := childEnv("claude", "configs/custom.json", []string{
		"HOME=/home/example", "CODEX_HOME=custom-codex", "CDX_CONFIG_PATH=peer.json", "CLX_CONFIG_PATH=stale.json",
		"CXX_CRON_ENGINE_ONLY=1", "CXX_CRON_COORDINATED=1", "CLAUDE_WRAPPER_RESTART_DEPTH=9", "CDX_AUTH_SESSION_HANDOFF=private", "CLX_AUTH_SESSION_HANDOFF=private",
		"CODEX_WRAPPER_RESTARTED=1", "CLAUDE_WRAPPER_RESTARTED=1", "CODEX_ORCH_PEER_SPAWN=1",
	})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(env, "\n")
	for _, forbidden := range []string{"HANDOFF", "DEPTH", "CXX_CRON_", "RESTARTED", "PEER_SPAWN", "stale.json"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("inherited %s", forbidden)
		}
	}
	for _, p := range []struct{ key, value string }{{"CODEX_HOME", "custom-codex"}, {"CDX_CONFIG_PATH", "peer.json"}, {"CLX_CONFIG_PATH", "configs/custom.json"}} {
		abs, _ := filepath.Abs(p.value)
		if !strings.Contains(joined, p.key+"="+abs) {
			t.Fatalf("lost %s", p.key)
		}
	}
}

func TestChildEnvironmentMatchesPathResolverWhitespace(t *testing.T) {
	env, err := childEnv("codex", "explicit path.json", []string{
		"CODEX_HOME=  /srv/codex  ", "CLX_CONFIG_PATH=   ",
		"CLX_CLAUDE_BIN=  relative/claude  ", "HOME=relative-home", "XDG_CONFIG_HOME=  /srv/config  ",
	})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(env, "\n")
	for _, expected := range []string{"CODEX_HOME=/srv/codex\n", "CLX_CONFIG_PATH=\n", "XDG_CONFIG_HOME=/srv/config\n"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("resolver mismatch: %s", joined)
		}
	}
	for _, item := range []struct{ key, path string }{{"HOME", "relative-home"}, {"CLX_CLAUDE_BIN", "relative/claude"}, {"CDX_CONFIG_PATH", "explicit path.json"}} {
		absolute, _ := filepath.Abs(item.path)
		if !strings.Contains(joined, item.key+"="+absolute) {
			t.Fatalf("relative path changed: %s", joined)
		}
	}
}

func TestDetachedSpawnReturnsBeforeChildAndRotatesPrivateLog(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "cron.log")
	if err := os.WriteFile(log, make([]byte, maxLogBytes), 0o600); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(dir, "fake-cxx")
	// Child waits for the test's release file, proving spawn did not await it.
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\"\nwhile [ ! -f release ]; do sleep 0.05; done\nprintf 'finished\\n'\n"
	if err := os.WriteFile(exe, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if err := spawn(exe, dir, os.Environ(), true); err != nil {
		t.Fatal(err)
	}
	defer os.WriteFile(filepath.Join(dir, "release"), nil, 0o600)
	if time.Since(start) > time.Second {
		t.Fatal("background spawn blocked launch")
	}
	if _, err := os.Stat(log + ".1"); err != nil {
		t.Fatal("log did not rotate", err)
	}
	if st, err := os.Stat(log); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("log mode: %v %v", st, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "release"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		raw, _ := os.ReadFile(log)
		if strings.Contains(string(raw), "finished") {
			if !strings.Contains(string(raw), "cron run --due --minimal") {
				t.Fatalf("wrong command: %s", raw)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("detached child did not complete")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestLogSymlinkIsNotFollowed(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "unrelated")
	if err := os.WriteFile(target, []byte("preserve"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "cron.log")); err != nil {
		t.Fatal(err)
	}
	if err := spawn("/bin/true", dir, os.Environ(), true); err == nil {
		t.Fatal("followed log symlink")
	}
	raw, _ := os.ReadFile(target)
	if string(raw) != "preserve" {
		t.Fatal("modified unrelated file")
	}
}

func TestForcedRequestBypassesCooldownButStillDedupes(t *testing.T) {
	dir, now := t.TempDir(), time.Now().UTC()
	run, err := beginAt(dir, true, now)
	if err != nil {
		t.Fatal(err)
	}
	if err := run.finishAt(nil, now); err != nil {
		t.Fatal(err)
	}
	calls := 0
	start := func() error { calls++; return nil }
	if err := requestAt(dir, now.Add(time.Minute), false, start); err != nil || calls != 0 {
		t.Fatalf("cooldown ignored: %d, %v", calls, err)
	}
	if err := requestAt(dir, now.Add(time.Minute), true, start); err != nil || calls != 1 {
		t.Fatalf("forced request suppressed: %d, %v", calls, err)
	}
	if err := requestAt(dir, now.Add(time.Minute+time.Second), true, start); err != nil || calls != 1 {
		t.Fatalf("forced request not de-duplicated: %d, %v", calls, err)
	}
}
