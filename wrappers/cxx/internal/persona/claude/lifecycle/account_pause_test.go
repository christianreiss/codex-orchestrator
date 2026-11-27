package lifecycle

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountgate"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
)

type fakePausePool struct {
	mu       sync.Mutex
	dir      string
	command  *accountpool.PauseCommand
	deadline time.Time
	changed  chan struct{}
	capable  *bool
}

func (p *fakePausePool) Pause(now time.Time) (accountpool.PauseCommand, time.Time, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.command == nil || !now.Before(p.deadline) {
		return accountpool.PauseCommand{}, time.Time{}, false
	}
	return *p.command, p.deadline, true
}

func (p *fakePausePool) PauseChanged() <-chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.changed
}

func (p *fakePausePool) GateDir() string { return p.dir }

func (p *fakePausePool) PauseCapable() (bool, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.capable == nil {
		return false, false
	}
	return *p.capable, true
}

func (p *fakePausePool) set(command *accountpool.PauseCommand, hold time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.command, p.deadline = command, time.Now().Add(hold)
	close(p.changed)
	p.changed = make(chan struct{})
}

type pauseReports struct {
	mu   sync.Mutex
	rows []string
	err  error
}

func (r *pauseReports) report(_ context.Context, round, state, reason string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return r.err
	}
	r.rows = append(r.rows, round+":"+state)
	return nil
}

func (r *pauseReports) all() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.rows, ",")
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func startPauseAgent(t *testing.T) (*fakePausePool, *pauseReports) {
	t.Helper()
	dir := accountgate.Dir(t.TempDir(), "lease")
	if err := accountgate.Prepare(dir); err != nil {
		t.Fatal(err)
	}
	pool := &fakePausePool{dir: dir, changed: make(chan struct{})}
	reports := &pauseReports{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		runPauseAgent(ctx, &pauseAgentDeps{pool: pool, report: reports.report, logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
			watchEvery: 2 * time.Millisecond, idleEvery: 2 * time.Millisecond, announceEvery: 5 * time.Millisecond})
	}()
	t.Cleanup(func() { cancel(); <-done })
	return pool, reports
}

func hookInput(event, agent string) accountgate.HookInput {
	return accountgate.HookInput{Event: event, SessionID: "s1", AgentID: agent}
}

func TestPauseAgentHoldsTheSessionAndReportsIt(t *testing.T) {
	pool, reports := startPauseAgent(t)
	// A hook has run: the launch announces that it can be paused, once.
	accountgate.Hook(pool.dir, hookInput("UserPromptSubmit", ""))
	eventually(t, "the capability announcement", func() bool { return reports.all() == ":capable" })
	yes := true
	pool.mu.Lock()
	pool.capable = &yes
	pool.mu.Unlock()

	// The server asks for a pause while the turn is in a model request.
	pool.set(&accountpool.PauseCommand{Round: "r1", HoldMS: 60_000}, time.Minute)
	eventually(t, "the gate", func() bool { _, ok := accountgate.Active(pool.dir, time.Now()); return ok })
	time.Sleep(20 * time.Millisecond)
	if got := reports.all(); got != ":capable" {
		t.Fatalf("reported %q while a model request was in flight", got)
	}
	// The response arrives and its tools run: nothing can follow but a hook.
	accountgate.Hook(pool.dir, hookInput("PreToolUse", ""))
	eventually(t, "the paused report", func() bool { return reports.all() == ":capable,r1:paused" })
	// The tools finish; the next model request waits in the gate.
	released := make(chan struct{})
	go func() { accountgate.Hook(pool.dir, hookInput("PostToolBatch", "")); close(released) }()
	select {
	case <-released:
		t.Fatal("the hook before the next model request was not held")
	case <-time.After(30 * time.Millisecond):
	}
	// The server ends the round: the hook returns.
	pool.set(nil, 0)
	select {
	case <-released:
	case <-time.After(5 * time.Second):
		t.Fatal("the session was not released when the round ended")
	}
	if _, ok := accountgate.Active(pool.dir, time.Now()); ok {
		t.Fatal("the gate outlived its round")
	}
	if got := reports.all(); got != ":capable,r1:paused" {
		t.Fatalf("reports: %s", got)
	}
}

func TestPauseAgentTakesBackAPausedReport(t *testing.T) {
	pool, reports := startPauseAgent(t)
	yes := true
	pool.mu.Lock()
	pool.capable = &yes
	pool.mu.Unlock()
	accountgate.Hook(pool.dir, hookInput("Stop", ""))
	pool.set(&accountpool.PauseCommand{Round: "r1", HoldMS: 60_000}, time.Minute)
	eventually(t, "the paused report", func() bool { return reports.all() == "r1:paused" })
	// The gate is gone although the round is not over (a hold that ran out,
	// a file somebody removed): the session can no longer vouch for itself.
	accountgate.Release(pool.dir)
	eventually(t, "the running report", func() bool { return strings.HasPrefix(reports.all(), "r1:paused,r1:running") })
}

func TestPauseAgentReleasesAtTheLocalDeadline(t *testing.T) {
	pool, _ := startPauseAgent(t)
	yes := true
	pool.mu.Lock()
	pool.capable = &yes
	pool.mu.Unlock()
	accountgate.Hook(pool.dir, hookInput("UserPromptSubmit", ""))
	pool.set(&accountpool.PauseCommand{Round: "r1", HoldMS: 60}, 60*time.Millisecond)
	started := time.Now()
	accountgate.Hook(pool.dir, hookInput("PostToolBatch", ""))
	if waited := time.Since(started); waited > 3*time.Second {
		t.Fatalf("held %v although the server never ended the round", waited)
	}
	eventually(t, "the gate to go", func() bool { _, ok := accountgate.Active(pool.dir, time.Now()); return !ok })
}

type statusErr int

func (e statusErr) Error() string   { return "http" }
func (e statusErr) HTTPStatus() int { return int(e) }

func TestPauseAgentStopsAskingAServerWithoutPauseRounds(t *testing.T) {
	pool, reports := startPauseAgent(t)
	reports.mu.Lock()
	reports.err = statusErr(404)
	reports.mu.Unlock()
	accountgate.Hook(pool.dir, hookInput("UserPromptSubmit", ""))
	time.Sleep(30 * time.Millisecond)
	reports.mu.Lock()
	reports.err = nil
	reports.mu.Unlock()
	time.Sleep(30 * time.Millisecond)
	if got := reports.all(); got != "" {
		t.Fatalf("announced again after a 404: %s", got)
	}
}

// --- the switch supervisor inside a pause round

type roundReports struct {
	mu   sync.Mutex
	rows []string
}

func (r *roundReports) add(_ context.Context, round, state, reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rows = append(r.rows, round+":"+state+":"+reason)
}

func (r *roundReports) all() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.rows, ",")
}

func runSwitcherUntil(t *testing.T, deps *accountSwitchDeps, stop func() bool) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan struct{})
	go func() { runAccountSwitcher(ctx, deps); close(finished) }()
	deadline := time.Now().Add(5 * time.Second)
	for !stop() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	cancel()
	<-finished
	if !stop() {
		t.Fatal("the supervisor did not get there")
	}
}

func TestSwitcherReportsDoneForAReadyRound(t *testing.T) {
	r := &switchRecorder{}
	pool := &fakeSwitchPool{pending: &directive, wake: make(chan struct{}, 1)}
	pool.wake <- struct{}{}
	deps := r.deps(pool)
	reports := &roundReports{}
	deps.pauseRound = func() (string, bool) { return "r1", true }
	deps.pauseReport = reports.add
	inner := deps.done
	deps.done = func(a int64, b string, res *accountpool.LeaseResponse, g claude.AuthGeneration, reason string) {
		inner(a, b, res, g, reason)
		pool.pending = nil
	}
	runSwitcherUntil(t, deps, func() bool { return reports.all() != "" })
	if got := reports.all(); got != "r1:done:" {
		t.Fatalf("reports: %s", got)
	}
}

func TestSwitcherEndsARoundWhoseFlushFails(t *testing.T) {
	// Asked to pause, not ready yet: the flush is checked right away.
	r := &switchRecorder{flushErr: errors.New("server says no")}
	pool := &fakeSwitchPool{pending: &directive, wake: make(chan struct{}, 1)}
	pool.wake <- struct{}{}
	deps := r.deps(pool)
	deps.idle = func() bool { return false } // every session is mid-turn
	reports := &roundReports{}
	deps.pauseRound = func() (string, bool) { return "r1", false }
	deps.pauseReport = reports.add
	runSwitcherUntil(t, deps, func() bool { return reports.all() != "" })
	time.Sleep(20 * time.Millisecond)
	if got := reports.all(); got != "r1:failed:flush: server says no" {
		t.Fatalf("reports (one per round): %s", got)
	}
	if strings.Contains(filterSteps(r.steps), "commit") {
		t.Fatalf("committed without a flush: %v", r.steps)
	}
}

func TestSwitcherReportsACommitThatFailsButNotOneAnotherSessionWon(t *testing.T) {
	r := &switchRecorder{commitErr: errors.New("gateway timeout")}
	pool := &fakeSwitchPool{pending: &directive, wake: make(chan struct{}, 1)}
	pool.wake <- struct{}{}
	deps := r.deps(pool)
	reports := &roundReports{}
	deps.pauseRound = func() (string, bool) { return "r1", true }
	deps.pauseReport = reports.add
	runSwitcherUntil(t, deps, func() bool { return reports.all() != "" })
	if got := reports.all(); !strings.HasPrefix(got, "r1:failed:commit account switch: gateway timeout") {
		t.Fatalf("reports: %s", got)
	}

	// Another session of the scope committed first: this one drops its
	// directive and says nothing; the winner reports.
	r = &switchRecorder{commitErr: codedErr("account_switch_stale")}
	pool = &fakeSwitchPool{pending: &directive, wake: make(chan struct{}, 1)}
	pool.wake <- struct{}{}
	deps = r.deps(pool)
	reports = &roundReports{}
	deps.pauseRound = func() (string, bool) { return "r1", true }
	deps.pauseReport = reports.add
	var commits atomic.Int32
	commit := deps.commit
	deps.commit = func(c context.Context, d accountpool.SwitchDirective) (*accountpool.LeaseResponse, error) {
		defer commits.Add(1)
		return commit(c, d)
	}
	runSwitcherUntil(t, deps, func() bool { return commits.Load() >= 1 })
	if len(pool.dropped) != 1 {
		t.Fatalf("the stale directive was not dropped: %v", pool.dropped)
	}
	if got := reports.all(); got != "" {
		t.Fatalf("a lost race was reported as a failure: %s", got)
	}
}

// A turn that starts between the commit and the write used to park the
// supervisor in an unbounded wait: no attempt was counted and the server
// never heard that the credentials were not written.
func TestCommittedSwitchReportsAWriteThatNeverGetsItsTurn(t *testing.T) {
	r := &switchRecorder{}
	deps := r.deps(&fakeSwitchPool{pending: &directive})
	deps.busyWait = 3 * time.Millisecond
	checks := 0
	deps.idle = func() bool { checks++; return checks <= 2 } // idle for the commit, busy ever after
	deps.write = func(context.Context, *accountpool.LeaseResponse, claude.AuthGeneration) (claude.AuthGeneration, bool, error) {
		return claude.AuthGeneration{}, false, errTurnBusy
	}
	outcome, committed, err := performAccountSwitch(context.Background(), deps, directive)
	if outcome != switchIncomplete || committed == nil || err == nil {
		t.Fatalf("first attempt: %v %v %v", outcome, committed, err)
	}
	attempts := 1
	for committed != nil {
		outcome, committed, _ = finishAccountSwitch(context.Background(), deps, committed)
		if attempts++; attempts > accountSwitchFinishTries+1 {
			t.Fatal("the committed switch never gave up")
		}
	}
	if attempts != accountSwitchFinishTries || outcome != switchIncomplete {
		t.Fatalf("gave up after %d attempts with %v", attempts, outcome)
	}
	if got := filterSteps(r.steps); !strings.HasSuffix(got, "resume,report") {
		t.Fatalf("the unfinished write was not reported: %s", got)
	}
}

func TestSwitcherKeepsReportingABindingTheFileDoesNotFollow(t *testing.T) {
	r := &switchRecorder{flag: true}
	pool := &fakeSwitchPool{wake: make(chan struct{}, 1)}
	deps := r.deps(pool)
	deps.pollEvery = 3 * time.Millisecond
	deps.idle = func() bool { return false }
	var mu sync.Mutex
	reported := 0
	deps.reportRepair = func(context.Context) error { mu.Lock(); reported++; mu.Unlock(); return nil }
	runSwitcherUntil(t, deps, func() bool { mu.Lock(); defer mu.Unlock(); return reported >= 3 })
	if strings.Contains(filterSteps(r.steps), "flush") {
		t.Fatalf("flushed next to running turns: %v", r.steps)
	}
}
