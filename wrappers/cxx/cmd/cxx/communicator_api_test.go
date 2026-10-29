package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

// apiFixture is an updater on a fake clock whose binary speaks level c, with
// the persisted below-minimum state in a temp dir (never the real ~/.cxx).
type apiFixture struct {
	u                         *commUpdater
	env                       *fakeUpdaterEnv
	clock                     time.Time
	applied, detects, fetched int
	logs                      []string
	agents                    int
}

func newAPIFixture(t *testing.T, c int, levels communicator.APILevels, offer *orchestrator.CronWrapperBlock) *apiFixture {
	t.Helper()
	f := &apiFixture{env: &fakeUpdaterEnv{trigger: make(chan struct{}, 1), levels: levels}, clock: time.Unix(1_800_000_000, 0)}
	u, _ := fixtureUpdater(f.env, "0.9.82", testSHA, offer)
	u.apiVersion = c
	u.apiStatePath = filepath.Join(t.TempDir(), "api-update.json")
	u.now = func() time.Time { return f.clock }
	u.agents = func() int { return f.agents }
	u.apply = func(context.Context, string) error { f.applied++; return nil }
	u.logf = func(format string, args ...any) { f.logs = append(f.logs, fmt.Sprintf(format, args...)) }
	check := u.check
	u.check = func(ctx context.Context, cfg *config.Config) (*orchestrator.CronCheckResponse, error) {
		f.detects++
		return check(ctx, cfg)
	}
	u.prefetch = func(context.Context, *config.Config, updateTarget) error { f.fetched++; return nil }
	f.u = u
	return f
}

var offer82 = &orchestrator.CronWrapperBlock{Action: "update", TargetVersion: "0.9.82", SHA256: testSHA}

func TestAPIFloorAbsentFieldsTakeNoAction(t *testing.T) {
	f := newAPIFixture(t, 1, communicator.APILevels{}, offer82)
	f.agents = 3
	if f.u.enforceMinimum(context.Background()) || f.applied != 0 || f.detects != 0 || f.env.retiredNow != 0 {
		t.Fatalf("absent levels must fail open: applied=%d detects=%d retiredNow=%d", f.applied, f.detects, f.env.retiredNow)
	}
}

func TestAPIFloorBelowMinimumUpdatesImmediatelyWithAgentsBusy(t *testing.T) {
	f := newAPIFixture(t, 1, communicator.APILevels{Server: 2, Min: 2}, offer82)
	f.agents = 3
	if !f.u.enforceMinimum(context.Background()) {
		t.Fatal("below the minimum the immediate path must own the pass")
	}
	if f.applied != 1 || f.fetched != 1 || f.env.retiredNow != 1 || f.env.retired != 0 {
		t.Fatalf("must install and replace the owner right away: applied=%d fetched=%d retiredNow=%d retired=%d", f.applied, f.fetched, f.env.retiredNow, f.env.retired)
	}
	last := f.env.reports[len(f.env.reports)-1]
	if last.State != "applied" || last.Reason != "api_below_minimum" {
		t.Fatalf("report = %+v", last)
	}
	if len(f.logs) != 1 || !strings.Contains(f.logs[0], "operator-requested exception") || !strings.Contains(f.logs[0], "3 agent(s) online") {
		t.Fatalf("the forced replacement must be logged as the operator exception: %q", f.logs)
	}
	if b := f.env.lastBackoff(); !b.Until.IsZero() {
		t.Fatalf("a successful attempt is not a backoff: %+v", b)
	}
}

func TestAPIFloorBelowMinimumResidentRequestsHandoff(t *testing.T) {
	f := newAPIFixture(t, 1, communicator.APILevels{Server: 2, Min: 2}, offer82)
	f.env.resident = true
	f.agents = 1
	handed := 0
	f.u.handoff = func(updateTarget, string) error { handed++; return nil }
	f.u.enforceMinimum(context.Background())
	if f.applied != 1 || handed != 1 || f.env.retiredNow != 0 {
		t.Fatalf("resident: applied=%d handed=%d retiredNow=%d", f.applied, handed, f.env.retiredNow)
	}
	// While the root helper replaces the service, the next passes neither
	// re-apply nor report a stuck backoff.
	f.clock = f.clock.Add(10 * time.Second)
	f.u.enforceMinimum(context.Background())
	if f.applied != 1 || !f.env.lastBackoff().Until.IsZero() {
		t.Fatalf("replacement pending: applied=%d backoff=%+v", f.applied, f.env.lastBackoff())
	}
}

func TestAPIFloorAtOrAboveCurrentDoesNothing(t *testing.T) {
	for _, levels := range []communicator.APILevels{{Server: 2, Min: 1}, {Server: 2, Min: 2}, {Server: 1, Min: 1}} {
		f := newAPIFixture(t, 2, levels, offer82)
		if f.u.enforceMinimum(context.Background()) || f.applied != 0 || f.detects != 0 {
			t.Fatalf("%+v: C >= S must not act (applied=%d detects=%d)", levels, f.applied, f.detects)
		}
	}
}

// After an immediate update that did not raise the level (the server demands
// a level no published binary has), the next owner backs off exponentially,
// capped, logs once per period and never re-downloads.
func TestAPIFloorBacksOffWhenTheUpdateDidNotRaiseTheLevel(t *testing.T) {
	levels := communicator.APILevels{Server: 3, Min: 3}
	first := newAPIFixture(t, 1, levels, offer82)
	first.u.enforceMinimum(context.Background())
	if first.applied != 1 || first.env.retiredNow != 1 {
		t.Fatal("the first owner must apply and retire")
	}
	// The successor runs the installed 0.9.82, still at level 2 < 3; the same
	// release is all the server offers.
	next := newAPIFixture(t, 2, levels, offer82)
	next.u.apiStatePath = first.u.apiStatePath
	next.u.running = "0.9.82"
	next.clock = first.clock.Add(time.Second)
	want := []time.Duration{time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 16 * time.Minute, 32 * time.Minute, time.Hour, time.Hour}
	for i, delay := range want {
		next.u.enforceMinimum(context.Background())
		b := next.env.lastBackoff()
		if b.Reason != "no_newer_release" || !b.Until.Equal(next.clock.Add(delay)) {
			t.Fatalf("attempt %d: backoff %+v, want %s after %s", i+1, b, delay, next.clock)
		}
		if len(next.logs) != i+1 || !strings.Contains(next.logs[i], "API level 3") || !strings.Contains(next.logs[i], "cxx update") {
			t.Fatalf("attempt %d: want one actionable line per period, got %q", i+1, next.logs)
		}
		// Polls inside the period neither re-check nor log.
		detects := next.detects
		for j := 0; j < 5; j++ {
			next.clock = next.clock.Add(delay / 10)
			next.u.enforceMinimum(context.Background())
		}
		if next.detects != detects || len(next.logs) != i+1 {
			t.Fatalf("attempt %d: hot loop inside the backoff (detects %d -> %d)", i+1, detects, next.detects)
		}
		next.clock = b.Until
	}
	if next.applied != 0 || next.fetched != 0 {
		t.Fatalf("no download may happen without a newer target: applied=%d fetched=%d", next.applied, next.fetched)
	}
	// The server lowers the minimum: the backoff clears and status recovers.
	next.env.setAPI(communicator.APILevels{Server: 3, Min: 2})
	if next.u.enforceMinimum(context.Background()) || !next.env.lastBackoff().Until.IsZero() {
		t.Fatal("a satisfied minimum must clear the backoff")
	}
}

// An owner restarted on the same binary after an attempt that "succeeded"
// without changing it starts inside the recorded backoff instead of applying
// again on every owner start.
func TestAPIFloorInstallThatDidNotTakeEffectDoesNotLoop(t *testing.T) {
	levels := communicator.APILevels{Server: 2, Min: 2}
	first := newAPIFixture(t, 1, levels, offer82)
	first.u.enforceMinimum(context.Background())
	again := newAPIFixture(t, 1, levels, offer82)
	again.u.apiStatePath = first.u.apiStatePath
	again.clock = first.clock.Add(5 * time.Second)
	again.u.enforceMinimum(context.Background())
	if again.applied != 0 || again.detects != 0 {
		t.Fatalf("re-applied on the same binary: applied=%d detects=%d", again.applied, again.detects)
	}
	if b := again.env.lastBackoff(); b.Reason != "update_did_not_take_effect" || !b.Until.Equal(first.clock.Add(time.Minute)) {
		t.Fatalf("backoff = %+v", b)
	}
	// After the period it retries once, with the next (doubled) delay recorded.
	again.clock = first.clock.Add(time.Minute)
	again.u.enforceMinimum(context.Background())
	if again.applied != 1 || again.env.retiredNow != 1 {
		t.Fatalf("retry after the backoff: applied=%d retiredNow=%d", again.applied, again.env.retiredNow)
	}
	third := newAPIFixture(t, 1, levels, offer82)
	third.u.apiStatePath = first.u.apiStatePath
	third.clock = again.clock.Add(time.Second)
	third.u.enforceMinimum(context.Background())
	if b := third.env.lastBackoff(); third.applied != 0 || !b.Until.Equal(again.clock.Add(2*time.Minute)) {
		t.Fatalf("second backoff period must double: applied=%d backoff=%+v", third.applied, b)
	}
}

// The period is measured from the end of a slow install (cxx update also runs
// the engine updates), so neither a successor on the same binary nor a
// failed install retries right away.
func TestAPIFloorBackoffStartsAfterASlowInstall(t *testing.T) {
	levels := communicator.APILevels{Server: 2, Min: 2}
	first := newAPIFixture(t, 1, levels, offer82)
	first.u.apply = func(context.Context, string) error {
		first.applied++
		first.clock = first.clock.Add(5 * time.Minute)
		return nil
	}
	first.u.enforceMinimum(context.Background())
	again := newAPIFixture(t, 1, levels, offer82)
	again.u.apiStatePath = first.u.apiStatePath
	again.clock = first.clock.Add(5 * time.Second)
	again.u.enforceMinimum(context.Background())
	if again.applied != 0 || again.env.lastBackoff().Reason != "update_did_not_take_effect" {
		t.Fatalf("successor re-applied after a slow install: applied=%d backoff=%+v", again.applied, again.env.lastBackoff())
	}

	failing := newAPIFixture(t, 1, levels, offer82)
	failing.u.apply = func(context.Context, string) error {
		failing.applied++
		failing.clock = failing.clock.Add(12 * time.Minute)
		return errors.New("timed out")
	}
	failing.u.enforceMinimum(context.Background())
	failing.clock = failing.clock.Add(10 * time.Second)
	failing.u.enforceMinimum(context.Background())
	if failing.applied != 1 || !failing.env.lastBackoff().Until.After(failing.clock) {
		t.Fatalf("a slow failed install retried at once: applied=%d backoff=%+v", failing.applied, failing.env.lastBackoff())
	}
}

func TestAPIFloorFailedApplyBacksOff(t *testing.T) {
	f := newAPIFixture(t, 1, communicator.APILevels{Server: 2, Min: 2}, offer82)
	f.u.apply = func(context.Context, string) error { f.applied++; return errors.New("broken") }
	f.u.enforceMinimum(context.Background())
	if b := f.env.lastBackoff(); b.Reason != "apply_failed" || f.env.retiredNow != 0 {
		t.Fatalf("failed apply: backoff %+v retiredNow=%d", b, f.env.retiredNow)
	}
	f.clock = f.clock.Add(30 * time.Second)
	f.u.enforceMinimum(context.Background())
	if f.applied != 1 {
		t.Fatalf("re-applied inside the backoff: %d", f.applied)
	}
}

func TestAPIFloorSharedInstallBacksOffAsRequiresRoot(t *testing.T) {
	f := newAPIFixture(t, 1, communicator.APILevels{Min: 2}, offer82)
	f.u.writable = func(string) bool { return false }
	f.u.enforceMinimum(context.Background())
	if f.applied != 0 || f.env.lastBackoff().Reason != "requires_root" {
		t.Fatalf("shared install: applied=%d backoff=%+v", f.applied, f.env.lastBackoff())
	}
}

// C < M through the owner's loop: one trigger installs and replaces the owner
// although agents stay online; the quiet gate is never consulted for the go.
func TestAPIFloorBelowMinimumFiresFromTheLoopWithAgentsOnline(t *testing.T) {
	env := &fakeUpdaterEnv{trigger: make(chan struct{}, 1), levels: communicator.APILevels{Server: 2, Min: 2}}
	u, _ := fixtureUpdater(env, "0.9.82", testSHA, offer82)
	u.apiStatePath = filepath.Join(t.TempDir(), "api-update.json")
	var applied atomic.Int32
	u.apply = func(context.Context, string) error { applied.Add(1); return nil }
	u.env = &lockedEnv{fakeUpdaterEnv: env}
	u.agents = func() int { return 4 }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go u.run(ctx)
	env.trigger <- struct{}{}
	deadline := time.Now().Add(2 * time.Second)
	for applied.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond) // further polls must not re-apply
	cancel()
	env.mu.Lock()
	defer env.mu.Unlock()
	if applied.Load() != 1 || env.retiredNow != 1 {
		t.Fatalf("below minimum with agents online: applied=%d retiredNow=%d", applied.Load(), env.retiredNow)
	}
}

// M <= C < S: the level change only triggers the ordinary check; the update
// stays staged while agents run and applies (quiet retirement, not the forced
// one) once the host is quiet. C >= S through the same loop stays current.
func TestAPIFloorQueuedUpdateWaitsForQuietInTheLoop(t *testing.T) {
	env := &fakeUpdaterEnv{trigger: make(chan struct{}, 1), levels: communicator.APILevels{Server: 2, Min: 1}}
	u, _ := fixtureUpdater(env, "0.9.82", testSHA, offer82)
	u.apiStatePath = filepath.Join(t.TempDir(), "api-update.json")
	var applied atomic.Int32
	u.apply = func(context.Context, string) error { applied.Add(1); return nil }
	locked := &lockedEnv{fakeUpdaterEnv: env}
	u.env = locked
	var busy atomic.Int32
	busy.Store(2)
	u.agents = func() int { return int(busy.Load()) }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go u.run(ctx)
	env.trigger <- struct{}{}
	time.Sleep(80 * time.Millisecond)
	if applied.Load() != 0 {
		t.Fatal("a queued update applied while agents were online")
	}
	busy.Store(0)
	deadline := time.Now().Add(2 * time.Second)
	for applied.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if applied.Load() != 1 {
		t.Fatal("the queued update never applied once quiet")
	}
	cancel()
	locked.mu.Lock()
	defer locked.mu.Unlock()
	env.mu.Lock()
	defer env.mu.Unlock()
	if env.retiredNow != 0 || env.retired != 1 {
		t.Fatalf("queued path must use the quiet retirement: retiredNow=%d retired=%d", env.retiredNow, env.retired)
	}
}
