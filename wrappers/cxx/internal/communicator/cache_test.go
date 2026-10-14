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
	s.primed = map[string]bool{scopeID(job): true}
	// A different session or account on the same native home shares the content.
	other := job
	other.SessionID, other.AccountID = "another-session", 42
	if !s.runSync(context.Background(), SyncRequest{Job: other, Operation: "primed"}).Primed {
		t.Fatal("primed state must follow engine and home, not the session")
	}
	// Grok runtime brokers share one content scope too.
	grok := fixtureJob(t, "grok")
	s.primed[scopeID(grok)] = true
	brokered := grok
	brokered.Auth, brokered.Broker = true, "/run/broker-a"
	if !s.runSync(context.Background(), SyncRequest{Job: brokered, Operation: "primed"}).Primed {
		t.Fatal("a Grok runtime broker must see its home's primed content")
	}
	if s.runSync(context.Background(), SyncRequest{Job: fixtureJob(t, "claude"), Operation: "primed"}).Primed {
		t.Fatal("another home must not inherit primed state")
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
	go func() { blocked <- s.executeSync(ctx, SyncRequest{Job: job, Operation: "bootstrap", IncludeAuth: true}) }()
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
