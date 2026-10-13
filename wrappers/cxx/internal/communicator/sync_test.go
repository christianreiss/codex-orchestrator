package communicator

import (
	"context"
	"encoding/json"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixtureJob(t *testing.T, engine string) syncJob {
	t.Helper()
	home := t.TempDir()
	job := syncJob{Engine: engine, Config: filepath.Join(home, "config.json"), Env: map[string]string{"HOME": home}}
	job.AuthPath = filepath.Join(jobHome(job), "auth.json")
	if engine == "claude" {
		job.AuthPath = filepath.Join(jobHome(job), ".credentials.json")
	}
	return job
}

func TestGrokAuthMetadataDistinguishesTransportLossFromRevocation(t *testing.T) {
	if revokedGrokAuth(json.RawMessage(`{"StatusCode":409,"Code":"communicator_outcome_unknown"}`)) {
		t.Fatal("transport uncertainty would terminate the native Grok session")
	}
	for _, raw := range []string{`{"StatusCode":401}`, `{"StatusCode":404}`, `{"StatusCode":409,"Code":"account_session_invalid"}`} {
		if !revokedGrokAuth(json.RawMessage(raw)) {
			t.Fatalf("revocation ignored: %s", raw)
		}
	}
	for _, raw := range []string{`{"StatusCode":503}`, `{}`, `invalid JSON`} {
		if revokedGrokAuth(json.RawMessage(raw)) {
			t.Fatalf("non-revocation became fatal: %s", raw)
		}
	}
}
func TestScopesShareWritersButNeverCrossHomesOrEngines(t *testing.T) {
	job := fixtureJob(t, "codex")
	peer := job
	peer.AccountID = 12
	peer.SessionID = "another-native-session"
	if scopeID(job) != scopeID(peer) {
		t.Fatal("sessions must share the native-home writer")
	}
	other := fixtureJob(t, "codex")
	if scopeID(job) == scopeID(other) {
		t.Fatal("different native homes share a writer")
	}
	peer.Engine = "claude"
	if scopeID(job) == scopeID(peer) {
		t.Fatal("engines share a writer")
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(job.Env["HOME"], alias); err != nil {
		t.Fatal(err)
	}
	peer = job
	peer.Env = map[string]string{"HOME": alias}
	if scopeID(job) != scopeID(peer) {
		t.Fatal("symlinked homes must share a writer")
	}
}
func TestRegistrationIsAtomicAndRejectsWrongAuthSource(t *testing.T) {
	s := &server{jobs: map[string]syncJob{}, jobRefs: map[string]int{}}
	valid := fixtureJob(t, "claude")
	bad := valid
	bad.AuthPath = filepath.Join(valid.Env["HOME"], "other-auth")
	body, _ := json.Marshal([]syncJob{valid, bad})
	_, _, err := s.registerJobs(httptest.NewRequest("POST", "/_comm/lease", strings.NewReader(string(body))))
	if err == nil || len(s.jobs) > 0 {
		t.Fatalf("partial registration: %v, %d", err, len(s.jobs))
	}
}
func TestAuthPushDoesNotInvalidateContentOrOtherAccounts(t *testing.T) {
	s := &server{authDirty: make(chan struct{}, 1)}
	a := fixtureJob(t, "codex")
	b := fixtureJob(t, "claude")
	sa, sb := s.stateLocked(a), s.stateLocked(b)
	future := time.Now().Add(time.Hour)
	sa.auth.AccountID = 1
	sb.auth.AccountID = 2
	sa.nextAuth = future
	sb.nextAuth = future
	sa.nextContent = future
	sb.nextContent = future
	s.invalidateAuth("codex", 1)
	if !sa.nextAuth.IsZero() || sb.nextAuth != future || sa.nextContent != future || sb.nextContent != future {
		t.Fatal("auth event invalidated unrelated scope/content")
	}
	select {
	case <-s.authDirty:
	default:
		t.Fatal("push did not wake scheduler")
	}
}
func TestPendingAuthStoresOnlyDigestAndSurvivesRestart(t *testing.T) {
	job := fixtureJob(t, "codex")
	if err := writePending(job, "generation-a"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(pendingPath(job))
	info, _ := os.Stat(pendingPath(job))
	if string(raw) != `{"generation":"generation-a"}` || info.Mode().Perm() != 0600 {
		t.Fatalf("pending metadata: %s %v", raw, info.Mode())
	}
	if pendingGeneration(job) != "generation-a" {
		t.Fatal("new process could not recover candidate identity")
	}
	if !ambiguous(SyncResult{Error: &SyncError{HTTP: json.RawMessage(`{"StatusCode":409,"Code":"communicator_outcome_unknown"}`)}}) {
		t.Fatal("lost ACK classified as definite")
	}
	if ambiguous(SyncResult{Error: &SyncError{HTTP: json.RawMessage(`{"StatusCode":403,"Code":"insecure_denied"}`)}}) {
		t.Fatal("definitive refusal classified as unknown")
	}
}
func TestEmptyTransportLeaseCannotCauseSyncFeedback(t *testing.T) {
	s := &server{jobs: map[string]syncJob{}, jobRefs: map[string]int{}, dirty: make(chan struct{}, 1)}
	upstream := httptest.NewServer(s)
	defer upstream.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", upstream.URL+"/_comm/lease", strings.NewReader("[]"))
	res, err := upstream.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	select {
	case <-s.dirty:
		t.Fatal("worker transport lease recursively scheduled sync")
	default:
	}
	cancel()
	io.Copy(io.Discard, res.Body)
}

func TestLateConfigBindingAndOlderOwnerCompatibility(t *testing.T) {
	root, err := os.MkdirTemp("", "comm-bind-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	t.Setenv("XDG_RUNTIME_DIR", root)
	t.Setenv("HOME", root)
	t.Setenv("CXX_COMMUNICATOR_SYNC", "")
	base := "https://binding.example"
	defer registry.Delete(base)
	cfg := config.Config{SchemaVersion: 1, Engine: "codex", IssuedAt: "2026-10-13T00:00:00Z", Orchestrator: config.Orchestrator{BaseURL: base, APIKey: "fixture-host-key", InstallationID: "fixture", CommunicatorProtocol: 1, CommunicatorSyncProtocol: 1}, Host: config.Host{ID: 1, FQDN: "binding.example", Secure: true}, Wrapper: config.Wrapper{Version: "0.9.73", Track: "stable", BinaryURL: base + "/download", BinarySHA256: strings.Repeat("0", 64)}}
	path := filepath.Join(root, "custom.json")
	raw, _ := json.Marshal(cfg)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	loaded, err := config.LoadForEngine(path, nil, true, "codex")
	if err != nil {
		t.Fatal(err)
	}
	ctx := WithSyncConfig(context.Background(), loaded)
	job, err := newSyncJob(ctx, base, "codex", "")
	if err != nil || job.Config != path || !job.Owner {
		t.Fatalf("late config binding: %+v %v", job, err)
	}
	ep := endpointFor(base)
	listener, err := net.Listen("unix", ep.socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"protocol":1,"version":"0.9.72"}`)
	})}
	go server.Serve(listener)
	defer server.Close()
	WithSyncConfig(ctx, loaded)
	if SyncManaged(base) {
		t.Fatal("old owner admitted unsupported managed-sync RPCs")
	}
	if ep.jobs["codex"].Owner {
		t.Fatal("old owner registered as auth owner")
	}
}

// A lease must never force a resync of other scopes. A genuinely new scope
// (including a fresh per-session Grok runtime) is woken and due on its own,
// while warm scopes keep their auth and content deadlines.
func TestLeaseOnCurrentScopeDoesNotForceBackgroundSync(t *testing.T) {
	s := &server{jobs: map[string]syncJob{}, jobRefs: map[string]int{}, dirty: make(chan struct{}, 1), authDirty: make(chan struct{}, 1), calls: map[string]*sharedCall{}}
	lease := func(job syncJob) {
		body, _ := json.Marshal([]syncJob{job})
		ctx, cancel := context.WithCancel(context.Background())
		req := httptest.NewRequest("POST", "/_comm/lease", strings.NewReader(string(body))).WithContext(ctx)
		done := make(chan struct{})
		go func() { defer close(done); s.ServeHTTP(httptest.NewRecorder(), req) }()
		time.Sleep(50 * time.Millisecond)
		cancel()
		<-done
	}
	signalled := func(ch chan struct{}) bool {
		select {
		case <-ch:
			return true
		default:
			return false
		}
	}
	codex, claude := fixtureJob(t, "codex"), fixtureJob(t, "claude")
	lease(codex)
	lease(claude)
	if signalled(s.dirty) || !signalled(s.authDirty) {
		t.Fatal("new scopes must wake the scheduler without forcing")
	}
	// Both scopes are now warm.
	future := time.Now().Add(time.Hour)
	s.mu.Lock()
	for _, job := range []syncJob{codex, claude} {
		st := s.stateLocked(job)
		st.nextAuth, st.nextContent = future, future
	}
	s.mu.Unlock()
	warm := func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, job := range []syncJob{codex, claude} {
			st := s.stateLocked(job)
			if !st.nextAuth.Equal(future) || !st.nextContent.Equal(future) {
				return false
			}
		}
		return true
	}
	again := codex
	again.SessionID, again.AccountID = "another-session", 9
	lease(again)
	if signalled(s.dirty) || signalled(s.authDirty) || !warm() {
		t.Fatal("an extra lease on a current scope disturbed the schedules")
	}
	grok := fixtureJob(t, "grok")
	grok.Auth, grok.Broker = true, filepath.Join(t.TempDir(), "runtime.sock")
	lease(grok)
	s.mu.Lock()
	fresh := s.stateLocked(grok)
	initial := fresh.nextAuth.IsZero() && fresh.nextContent.IsZero()
	s.mu.Unlock()
	if signalled(s.dirty) || !signalled(s.authDirty) || !initial {
		t.Fatal("a fresh Grok runtime scope was not scheduled on its own")
	}
	if !warm() {
		t.Fatal("a fresh Grok runtime scope resynced the warm Codex/Claude scopes")
	}
}

// A scheduler pass may be satisfied without an exchange, so an explicit caller
// must never coalesce onto it and receive its empty result.
func TestScheduledContentPassDoesNotCoalesceWithExplicitCaller(t *testing.T) {
	job := syncJob{Engine: "grok", Config: "/c/grok.json", Env: map[string]string{"HOME": "/h"}}
	explicit := SyncRequest{Job: job, Operation: "content"}
	scheduled := SyncRequest{Job: job, Operation: "content", Scheduled: true}
	if coalesceKey(explicit) == coalesceKey(scheduled) {
		t.Fatal("scheduled and explicit content requests share a coalescing key")
	}
	other := scheduled
	other.Job.SessionID = "another-session"
	if coalesceKey(scheduled) != coalesceKey(other) {
		t.Fatal("identical scheduled passes must still coalesce regardless of session identity")
	}
}
