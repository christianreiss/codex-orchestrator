package communicator

import (
	"context"
	"testing"
	"time"
)

func TestPrimedScopeIsPerEngineAndHomeAndOnlyAfterContent(t *testing.T) {
	s := &server{}
	job := fixtureJob(t, "claude")
	if s.runSync(context.Background(), SyncRequest{Job: job, Operation: "primed"}).Primed {
		t.Fatal("a fresh owner must not report a primed scope")
	}
	s.primed = map[string]time.Time{scopeID(job): time.Now()}
	// A different session or account on the same native home shares the content.
	other := job
	other.SessionID, other.AccountID = "another-session", 42
	if !s.runSync(context.Background(), SyncRequest{Job: other, Operation: "primed"}).Primed {
		t.Fatal("primed state must follow engine and home, not the session")
	}
	// Grok runtime brokers share one content scope too.
	grok := fixtureJob(t, "grok")
	s.primed[scopeID(grok)] = time.Now()
	brokered := grok
	brokered.Auth, brokered.Broker = true, "/run/broker-a"
	if !s.runSync(context.Background(), SyncRequest{Job: brokered, Operation: "primed"}).Primed {
		t.Fatal("a Grok runtime broker must see its home's primed content")
	}
	if s.runSync(context.Background(), SyncRequest{Job: fixtureJob(t, "claude"), Operation: "primed"}).Primed {
		t.Fatal("another home must not inherit primed state")
	}
}

// A server invalidation (a pushed frame or the reconnect after a deploy) only
// re-runs content for scopes with a live lease. Every primed scope must
// therefore stop answering primed until a content pass that started after it.
func TestInvalidationUnprimesScopeUntilNextContentPass(t *testing.T) {
	s := &server{dirty: make(chan struct{}, 1)}
	job := fixtureJob(t, "codex")
	primed := func() bool {
		return s.runSync(context.Background(), SyncRequest{Job: job, Operation: "primed"}).Primed
	}
	s.mu.Lock()
	s.stateLocked(job)
	s.mu.Unlock()
	s.primed = map[string]time.Time{scopeID(job): time.Now()}
	if !primed() {
		t.Fatal("a scope whose content pass followed every invalidation must be primed")
	}
	s.mu.Lock()
	views := s.scopeViewsLocked()
	s.mu.Unlock()
	if len(views) != 1 || views[0]["primed"] != true {
		t.Fatalf("status must report the current scope as primed: %+v", views)
	}
	time.Sleep(time.Millisecond)
	s.invalidate()
	if primed() {
		t.Fatal("an invalidation must unprime a scope until its next content pass")
	}
	s.mu.Lock()
	views = s.scopeViewsLocked()
	s.mu.Unlock()
	if len(views) != 1 || views[0]["primed"] != false {
		t.Fatalf("status must not report a stale scope as primed: %+v", views)
	}
	// A pass that started before the invalidation read state older than it.
	s.mu.Lock()
	raced := s.invalidatedAt.Add(-time.Millisecond)
	s.primed[scopeID(job)] = raced
	s.mu.Unlock()
	if primed() {
		t.Fatal("a pass that started before the invalidation must not prime the scope")
	}
	s.mu.Lock()
	s.primed[scopeID(job)] = s.invalidatedAt.Add(time.Millisecond)
	s.mu.Unlock()
	if !primed() {
		t.Fatal("a pass that started after the invalidation must prime the scope again")
	}
}

// An explicit sync never asks the owner: it always runs a content exchange.
func TestExplicitContentIsNeverPrimed(t *testing.T) {
	ctx := context.Background()
	if ExplicitContent(ctx) {
		t.Fatal("a plain context must not be an explicit sync")
	}
	ctx = WithExplicitContent(ctx)
	if !ExplicitContent(ctx) {
		t.Fatal("WithExplicitContent must mark the context")
	}
	if Primed(ctx, "https://example.invalid", "codex", "") {
		t.Fatal("an explicit sync must never take the warm-cache path")
	}
}

func TestSyncLocksSeparateContentFromCredentialWork(t *testing.T) {
	for _, tc := range []struct {
		in            SyncRequest
		content, auth bool
	}{
		{SyncRequest{Operation: "content"}, true, false},
		{SyncRequest{Operation: "skills"}, true, false},
		{SyncRequest{Operation: "bootstrap"}, true, false},
		{SyncRequest{Operation: "bootstrap", IncludeAuth: true}, true, true},
		{SyncRequest{Operation: "auth"}, true, true},
		{SyncRequest{Operation: "bootstrap", IncludeAuth: true, SkipContent: true}, false, true},
	} {
		content, auth := syncLocks(tc.in)
		if content != tc.content || auth != tc.auth {
			t.Fatalf("%+v: locks content=%v auth=%v, want %v/%v", tc.in, content, auth, tc.content, tc.auth)
		}
	}
}

// A warm-cache launch's auth bootstrap must not queue behind a background
// content pass that holds the scope's content gate.
func TestAuthOnlyBootstrapDoesNotWaitOnContentGate(t *testing.T) {
	s := &server{cfg: nil}
	job := fixtureJob(t, "claude")
	s.mu.Lock()
	state := s.stateLocked(job)
	s.mu.Unlock()
	state.gate <- struct{}{} // a content pass is running
	defer func() { <-state.gate }()
	done := make(chan SyncResult, 1)
	go func() {
		done <- s.executeSync(context.Background(), SyncRequest{Job: job, Operation: "bootstrap", IncludeAuth: true, SkipContent: true})
	}()
	select {
	case <-done: // proceeds past the gates (and fails later on the fixture's missing config)
	case <-time.After(2 * time.Second):
		t.Fatal("auth-only bootstrap waited on the content gate")
	}
	blocked := make(chan SyncResult, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	go func() {
		blocked <- s.executeSync(ctx, SyncRequest{Job: job, Operation: "bootstrap", IncludeAuth: true})
	}()
	if out := <-blocked; out.Error == nil || out.Error.Message != context.DeadlineExceeded.Error() {
		t.Fatalf("a full bootstrap must still serialize with content work, got %+v", out.Error)
	}
}

// Resident content jobs prime the same scope a user launch asks about, so a
// resident owner's background passes make the next launch warm.
func TestResidentContentJobPrimesUserLaunchScope(t *testing.T) {
	home := t.TempDir()
	for _, engine := range []string{"codex", "claude", "grok"} {
		resident := syncJob{Owner: true, Engine: engine, Config: home + "/" + engine + ".json", Env: map[string]string{"HOME": home}}
		launch := syncJob{Engine: engine, Config: home + "/" + engine + ".json", Env: map[string]string{"HOME": home, "XDG_CONFIG_HOME": home + "/.config"}, AccountID: 7, SessionID: "s"}
		if engine != "grok" {
			launch.AuthPath = fixtureAuthPath(launch)
		}
		if scopeID(resident) != scopeID(launch) {
			t.Fatalf("%s: resident scope %s != launch scope %s", engine, scopeID(resident), scopeID(launch))
		}
	}
}

func fixtureAuthPath(job syncJob) string {
	if job.Engine == "claude" {
		return jobHome(job) + "/.credentials.json"
	}
	return jobHome(job) + "/auth.json"
}
