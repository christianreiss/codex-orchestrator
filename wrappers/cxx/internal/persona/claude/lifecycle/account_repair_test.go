package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

func boundHead(account int64) flushResult {
	return flushResult{Bound: &accountpool.LeaseResponse{AccountID: account, Auth: json.RawMessage(`{}`), VerificationState: "verified"}}
}

// runSwitcherUntilRepaired runs the supervisor on one wake and stops it once
// the repair flag was cleared or the deadline passes.
func runSwitcherUntilRepaired(t *testing.T, r *switchRecorder, pool *fakeSwitchPool) {
	t.Helper()
	pool.wake = make(chan struct{}, 1)
	pool.wake <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan struct{})
	deps := r.deps(pool)
	// The recorder belongs to the supervisor goroutine while it runs. Clearing
	// the flag is the last thing a repair decides; whatever follows it in the
	// same pass (resume, notice) is done when the goroutine has returned.
	cleared := make(chan struct{}, 1)
	clearRepair := deps.clearRepair
	deps.clearRepair = func() {
		clearRepair()
		select {
		case cleared <- struct{}{}:
		default:
		}
	}
	go func() { runAccountSwitcher(ctx, deps); close(finished) }()
	select {
	case <-cleared:
	case <-time.After(5 * time.Second):
	}
	cancel()
	<-finished
	if r.flag {
		t.Fatalf("supervisor did not get there: %v", r.steps)
	}
}

// The server committed, the answer never arrived. The directive is still
// pending here, the file is still the old account's, and the server already
// answers for the new one.
func TestLostCommitAnswerIsRepeatedUntilTheCredentialsAreWritten(t *testing.T) {
	r := &switchRecorder{commitErrs: []error{errors.New("connection reset")}}
	pool := &fakeSwitchPool{pending: &directive}
	deps := r.deps(pool)
	outcome, committed, err := performAccountSwitch(context.Background(), deps, directive)
	if outcome != switchRetry || committed != nil || err == nil || pool.pending == nil {
		t.Fatalf("lost answer: %v %v %v pending=%v", outcome, committed, err, pool.pending)
	}
	if !r.flag {
		t.Fatal("nothing remembers that the commit may have happened")
	}
	// The next flush already meets the new binding; the old login is flushed
	// all the same and the same directive is committed again.
	r.steps, r.flushSeq = nil, []flushResult{boundHead(directive.AccountID)}
	outcome, committed, err = performAccountSwitch(context.Background(), deps, directive)
	if outcome != switchDone || committed != nil || err != nil {
		t.Fatalf("repeat: %v %v %v", outcome, committed, err)
	}
	if got := filterSteps(r.steps); got != "flush,pause,commit,write:ok,apply,resume,done" {
		t.Fatalf("repeat order: %s", got)
	}
	if r.flag {
		t.Fatal("flag survived the write")
	}
}

// The supervisor that committed is gone: killed after the commit, before the
// write. Nothing is pending anywhere; only the flag and the server know.
func TestKilledBetweenCommitAndWriteIsFinishedByTheNextSupervisor(t *testing.T) {
	r := &switchRecorder{flag: true, flushSeq: []flushResult{boundHead(7)}}
	runSwitcherUntilRepaired(t, r, &fakeSwitchPool{})
	got := filterSteps(r.steps)
	if !strings.HasPrefix(got, "heartbeat,flush,pause,write:ok,apply,resume,done") || strings.Contains(got, "commit") {
		t.Fatalf("repair order: %s", got)
	}
}

// A sibling's switch was adopted from a heartbeat. Usually the sibling wrote
// the credentials; then the check finds nothing to do and never pauses sync.
func TestAdoptedSwitchIsCheckedAndLeftAloneWhenTheSiblingWrote(t *testing.T) {
	r := &switchRecorder{flag: true}
	runSwitcherUntilRepaired(t, r, &fakeSwitchPool{})
	if got := filterSteps(r.steps); strings.Contains(got, "write") || strings.Contains(got, "pause") || strings.Contains(got, "done") || !strings.Contains(got, "flush") {
		t.Fatalf("check order: %s", got)
	}
}

// The sibling committed and died. No directive is left for the adopter; the
// flag set at adoption makes it write the credentials itself.
func TestAdoptedSwitchIsWrittenWhenNoSiblingDid(t *testing.T) {
	r := &switchRecorder{flag: true, flushSeq: []flushResult{boundHead(7)}, writeSeq: []string{"busy", "cas"}}
	// After the CAS miss the server still reports the mismatch: write again.
	r.flushSeq = append(r.flushSeq, boundHead(7))
	runSwitcherUntilRepaired(t, r, &fakeSwitchPool{})
	got := filterSteps(r.steps)
	if !strings.Contains(got, "flush,pause,write:busy,write:cas,matches,flush,write:ok,apply,resume,done") {
		t.Fatalf("order: %s", got)
	}
}

func TestRepairEndsWhenALaterFlushFindsTheBoundAccountInPlace(t *testing.T) {
	// Someone else wrote between the check and the write: the CAS misses, the
	// bytes differ (a newer head), and the server no longer sees a mismatch.
	r := &switchRecorder{flag: true, writeSeq: []string{"cas"}}
	deps := r.deps(&fakeSwitchPool{})
	c := &committedSwitch{res: boundHead(7).Bound, repair: true}
	outcome, committed, err := finishAccountSwitch(context.Background(), deps, c)
	if outcome != switchDone || committed != nil || err != nil || r.flag {
		t.Fatalf("repair: %v %v %v flag=%v", outcome, committed, err, r.flag)
	}
	if got := filterSteps(r.steps); got != "write:cas,matches,flush,apply,resume,done" {
		t.Fatalf("order: %s", got)
	}
}

func TestRepairThatCannotWriteStaysFlaggedAndReportsNothing(t *testing.T) {
	r := &switchRecorder{flag: true}
	deps := r.deps(&fakeSwitchPool{})
	deps.write = func(context.Context, *accountpool.LeaseResponse, claude.AuthGeneration) (claude.AuthGeneration, bool, error) {
		return claude.AuthGeneration{}, false, nil
	}
	r.flushSeq = make([]flushResult, 0)
	for i := 0; i < 2*accountSwitchWrites; i++ {
		r.flushSeq = append(r.flushSeq, boundHead(7))
	}
	c := &committedSwitch{res: boundHead(7).Bound, repair: true, applied: true, attempts: accountSwitchFinishTries - 1}
	outcome, committed, _ := finishAccountSwitch(context.Background(), deps, c)
	got := filterSteps(r.steps)
	if outcome != switchIncomplete || committed != nil || !r.flag || strings.Contains(got, "report") || !strings.HasSuffix(got, "resume") {
		t.Fatalf("give up: %v %v flag=%v %s", outcome, committed, r.flag, got)
	}
}

func TestReflushFollowsTheServersCurrentBinding(t *testing.T) {
	label, generation := "b@example.com", int64(5)
	c := &committedSwitch{res: &accountpool.LeaseResponse{AccountID: 7, AccountLabel: label, BindingGeneration: &generation}, applied: true}
	// The same account with a newer head: label and generation stay.
	newer := boundHead(7)
	newer.Bound.CanonicalDigest = strings.Repeat("c", 64)
	if c.reflushed(newer) || c.res.CanonicalDigest != newer.Bound.CanonicalDigest || c.res.AccountLabel != label || c.res.BindingGeneration != &generation || !c.applied {
		t.Fatalf("newer head: %+v", c.res)
	}
	// The scope moved on to another account meanwhile: that one is written
	// and recorded.
	if c.reflushed(boundHead(9)) || c.res.AccountID != 9 || c.applied {
		t.Fatalf("moved on: %+v applied=%v", c.res, c.applied)
	}
	// Without a mismatch a committed switch still has its write to do (an
	// older server never reports one); a repair is finished.
	if c.reflushed(flushResult{}) {
		t.Fatal("a committed switch was taken for written")
	}
	c.repair = true
	if !c.reflushed(flushResult{}) {
		t.Fatal("repair not finished although the server sees no mismatch")
	}
}

func TestFlushIsRelaxedOnlyWhenTheServerSaysTheBoundAccountIsUnusable(t *testing.T) {
	unusable, usable := false, true
	for _, c := range []struct {
		flag *bool
		want bool
	}{{nil, false}, {&usable, false}, {&unusable, true}} {
		r := &switchRecorder{writeSeq: []string{"cas", "ok"}}
		d := directive
		d.BoundAccountUsable = c.flag
		if outcome, _, err := performAccountSwitch(context.Background(), r.deps(&fakeSwitchPool{}), d); outcome != switchDone || err != nil {
			t.Fatalf("outcome=%v err=%v", outcome, err)
		}
		// The flush before the commit and the one after the CAS miss.
		if len(r.relaxed) != 2 || r.relaxed[0] != c.want || r.relaxed[1] != c.want {
			t.Fatalf("usable=%v: relaxed=%v", c.flag, r.relaxed)
		}
	}
}

func stubFlush(t *testing.T, sync func(call int) (SessionAuthSyncResult, error)) *int {
	t.Helper()
	calls := 0
	previousSync, previousConfirmed := sessionAuthSync, confirmedAuthGeneration
	t.Cleanup(func() { sessionAuthSync, confirmedAuthGeneration = previousSync, previousConfirmed })
	sessionAuthSync = func(context.Context, *orchestrator.Client, *slog.Logger) (SessionAuthSyncResult, error) {
		calls++
		return sync(calls)
	}
	confirmedAuthGeneration = func(context.Context) (claude.AuthGeneration, error) {
		return claude.AuthGeneration{Exists: true, Digest: strings.Repeat("d", 64)}, nil
	}
	return &calls
}

func TestFlushReturnsTheBoundAccountWhenTheFileIsAnotherAccounts(t *testing.T) {
	local := claude.AuthGeneration{Exists: true, Digest: strings.Repeat("a", 64)}
	mismatch := &BoundAccountMismatch{BoundAccountID: 7, PresentedAccountID: 3, Auth: json.RawMessage(`{"x":1}`), CanonicalDigest: strings.Repeat("b", 64), VerificationState: "verified", Generation: local}
	calls := stubFlush(t, func(int) (SessionAuthSyncResult, error) { return SessionAuthSyncResult{Generation: local}, mismatch })
	flushed, err := flushAccountAuth(context.Background(), nil, nil, false)
	if err != nil || *calls != 1 || flushed.Generation != local || flushed.Bound == nil || flushed.Bound.AccountID != 7 || flushed.Bound.VerificationState != "verified" || string(flushed.Bound.Auth) != `{"x":1}` {
		t.Fatalf("flush: %+v %v calls=%d", flushed, err, *calls)
	}
}

// The old account rotated after the server had already moved the scope. The
// upload is filed under the login's own account and its answer looks like any
// other; only the exchange after it shows the binding.
func TestFlushAsksAgainAfterAnUploadAndMeetsTheNewBinding(t *testing.T) {
	local := claude.AuthGeneration{Exists: true, Digest: strings.Repeat("a", 64)}
	calls := stubFlush(t, func(call int) (SessionAuthSyncResult, error) {
		if call == 1 {
			return SessionAuthSyncResult{Generation: local, Uploaded: true}, nil
		}
		return SessionAuthSyncResult{Generation: local, ServerKnown: true}, &BoundAccountMismatch{BoundAccountID: 7, PresentedAccountID: 3, Auth: json.RawMessage(`{}`), VerificationState: "verified", Generation: local}
	})
	flushed, err := flushAccountAuth(context.Background(), nil, nil, false)
	if err != nil || *calls != 2 || flushed.Bound == nil || flushed.Bound.AccountID != 7 || flushed.Generation != local {
		t.Fatalf("flush: %+v %v calls=%d", flushed, err, *calls)
	}
	// Without a mismatch the second exchange changes nothing.
	calls = stubFlush(t, func(call int) (SessionAuthSyncResult, error) {
		return SessionAuthSyncResult{Generation: local, Uploaded: call == 1}, nil
	})
	flushed, err = flushAccountAuth(context.Background(), nil, nil, false)
	if err != nil || *calls != 2 || flushed.Bound != nil || !flushed.Generation.Exists {
		t.Fatalf("plain upload: %+v %v calls=%d", flushed, err, *calls)
	}
	// A failed second exchange is not a confirmation.
	stubFlush(t, func(call int) (SessionAuthSyncResult, error) {
		if call == 1 {
			return SessionAuthSyncResult{Generation: local, Uploaded: true}, nil
		}
		return SessionAuthSyncResult{}, errors.New("offline")
	})
	if _, err = flushAccountAuth(context.Background(), nil, nil, false); err == nil {
		t.Fatal("flush confirmed without knowing the binding")
	}
}

func TestRelaxedFlushAcceptsOnlyWhatLeavesNothingToUpload(t *testing.T) {
	local := claude.AuthGeneration{Exists: true, Digest: strings.Repeat("a", 64)}
	rejected := &orchestrator.HTTPError{StatusCode: http.StatusUnprocessableEntity, Code: "validation_failed"}
	for _, c := range []struct {
		name    string
		result  SessionAuthSyncResult
		err     error
		relaxed bool
	}{
		{"server knows the file, head unverified", SessionAuthSyncResult{Generation: local, ServerKnown: true}, ErrSessionAuthUnverified, true},
		{"upload accepted, head unverified", SessionAuthSyncResult{Generation: local, Uploaded: true}, ErrSessionAuthUnverified, true},
		{"rejected for good in the answer", SessionAuthSyncResult{Generation: local, Rejected: true}, ErrSessionAuthUnverified, true},
		{"rejected for good by status", SessionAuthSyncResult{Generation: local}, rejected, true},
		{"offered but not accepted", SessionAuthSyncResult{Generation: local}, ErrSessionAuthUnverified, false},
		{"account being removed takes no more logins", SessionAuthSyncResult{Generation: local}, &orchestrator.HTTPError{StatusCode: http.StatusConflict, Code: "account_removed"}, true},
		{"another conflict", SessionAuthSyncResult{Generation: local}, &orchestrator.HTTPError{StatusCode: http.StatusConflict, Code: "account_assignment_required"}, false},
		{"identity unavailable", SessionAuthSyncResult{Generation: local}, &orchestrator.HTTPError{StatusCode: http.StatusServiceUnavailable, Code: "account_identity_unavailable"}, false},
		{"offline", SessionAuthSyncResult{Generation: local}, errors.New("dial tcp: timeout"), false},
		{"native change in flight", SessionAuthSyncResult{Generation: local, ServerKnown: true, Deferred: true}, ErrSessionAuthUnverified, false},
		{"no local file", SessionAuthSyncResult{ServerKnown: true}, ErrSessionAuthUnverified, false},
	} {
		// The first exchange decides; an accepted upload asks once more and
		// gets the same answer.
		stubFlush(t, func(int) (SessionAuthSyncResult, error) { return c.result, c.err })
		if _, err := flushAccountAuth(context.Background(), nil, nil, false); err == nil {
			t.Fatalf("%s: a strict flush passed", c.name)
		}
		flushed, err := flushAccountAuth(context.Background(), nil, nil, true)
		if (err == nil) != c.relaxed || (c.relaxed && flushed.Generation != local) {
			t.Fatalf("%s: relaxed flush %+v err=%v", c.name, flushed, err)
		}
	}
}

func mismatchClient(t *testing.T, remote json.RawMessage, bound int64) (*orchestrator.Client, string) {
	t.Helper()
	// The local login is the newer of the two: refresh times of different
	// accounts must not decide anything.
	if err := claude.WriteAuth(sessionPayload("old", time.Now())); err != nil {
		t.Fatal(err)
	}
	path, _ := claude.AuthPath()
	client := sessionClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "outdated", "auth": remote, "account_id": 7, "presented_account_id": 3,
			"canonical_digest":       strings.Repeat("b", 64),
			"canonical_last_refresh": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano),
			"verification_state":     "verified",
		})
	})
	client.Pool = accountpool.Load("claude", path, client.BaseURL)
	client.Pool.AccountID = bound
	return client, path
}

func setScopeInUse(t *testing.T, inUse bool) {
	t.Helper()
	previous := scopeInUse
	t.Cleanup(func() { scopeInUse = previous })
	scopeInUse = func(*orchestrator.Client) bool { return inUse }
}

func TestSessionSyncLeavesAnotherAccountsLoginToTheTurnGateWhileSessionsRun(t *testing.T) {
	_, remote := sessionFixture(t)
	client, path := mismatchClient(t, remote, 7)
	setScopeInUse(t, true)
	before, _ := os.ReadFile(path)
	result, err := SyncSessionAuth(context.Background(), client, nil)
	var mismatch *BoundAccountMismatch
	if !errors.As(err, &mismatch) || mismatch.BoundAccountID != 7 || mismatch.PresentedAccountID != 3 || mismatch.Generation != result.Generation || result.Adopted {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Fatal("a background sync replaced credentials a session may be using")
	}
	if !client.Pool.RepairPending() {
		t.Fatal("no supervisor will hear about the mismatch")
	}
}

func TestSessionSyncWritesTheBoundAccountWhenNothingRuns(t *testing.T) {
	_, remote := sessionFixture(t)
	client, path := mismatchClient(t, remote, 7)
	setScopeInUse(t, false)
	client.Pool.MarkRepair()
	result, err := SyncSessionAuth(context.Background(), client, nil)
	if err != nil || !result.Adopted || result.Deferred {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if raw, _ := os.ReadFile(path); !strings.Contains(string(raw), `"remote"`) {
		t.Fatal("the bound account's credentials were not written although its head is older")
	}
	if client.Pool.RepairPending() {
		t.Fatal("flag survived the write")
	}
}

func TestSessionSyncWithoutABindingKeepsTheNewerLocalLogin(t *testing.T) {
	_, remote := sessionFixture(t)
	client, path := mismatchClient(t, remote, 0)
	setScopeInUse(t, false)
	result, err := SyncSessionAuth(context.Background(), client, nil)
	var mismatch *BoundAccountMismatch
	if errors.As(err, &mismatch) || result.Adopted {
		t.Fatalf("an unbound scope followed the default account: %+v %v", result, err)
	}
	if raw, _ := os.ReadFile(path); !strings.Contains(string(raw), `"old"`) || client.Pool.RepairPending() {
		t.Fatal("local login replaced or flagged without a binding")
	}
}
