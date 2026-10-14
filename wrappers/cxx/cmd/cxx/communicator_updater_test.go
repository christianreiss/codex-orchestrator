package main

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

type fakeUpdaterEnv struct {
	trigger  chan struct{}
	resident bool
	reports  []communicator.UpdateStatus
	retired  int
}

func (f *fakeUpdaterEnv) Trigger() <-chan struct{}            { return f.trigger }
func (f *fakeUpdaterEnv) ConfigPath() string                  { return "/cfg/cdx.json" }
func (f *fakeUpdaterEnv) Version() string                     { return "0.9.81" }
func (f *fakeUpdaterEnv) Busy() int                           { return 0 }
func (f *fakeUpdaterEnv) Resident() bool                      { return f.resident }
func (f *fakeUpdaterEnv) Report(st communicator.UpdateStatus) { f.reports = append(f.reports, st) }
func (f *fakeUpdaterEnv) Retire()                             { f.retired++ }

var testSHA = strings.Repeat("ab", 32)

func fixtureUpdater(env *fakeUpdaterEnv, signedVersion, signedSHA string, offer *orchestrator.CronWrapperBlock) (*commUpdater, *int) {
	applied := 0
	cfg := &config.Config{Engine: "codex", Orchestrator: config.Orchestrator{CommunicatorUpdateProtocol: communicator.UpdateProtocol}, Wrapper: config.Wrapper{Version: signedVersion, BinarySHA256: signedSHA, BinaryURL: "https://o.example/bin"}}
	u := &commUpdater{env: env, running: env.Version(), backstop: time.Hour, quietPoll: 10 * time.Millisecond, now: time.Now, retryDelay: time.Minute,
		load:  func(string) (*config.Config, error) { return cfg, nil },
		fetch: func(context.Context, *config.Config) (*config.Config, error) { return cfg, nil },
		check: func(context.Context, *config.Config) (*orchestrator.CronCheckResponse, error) {
			return &orchestrator.CronCheckResponse{Action: "update", Wrapper: offer}, nil
		},
		prefetch: func(context.Context, *config.Config, updateTarget) error { return nil },
		agents:   func() int { return 0 },
		target:   func() (string, error) { return "/home/u/.local/bin/cxx", nil },
		writable: func(string) bool { return true },
		apply:    func(context.Context, string) error { applied++; return nil },
		handoff:  func(updateTarget, string) error { return nil },
	}
	return u, &applied
}

func TestUpdaterRequiresServerOfferAndSignedTargetToAgree(t *testing.T) {
	offer := &orchestrator.CronWrapperBlock{Action: "update", TargetVersion: "0.9.82", SHA256: testSHA}
	cases := []struct {
		name         string
		version, sha string
		offer        *orchestrator.CronWrapperBlock
		want, reason string
	}{
		{"agree", "0.9.82", testSHA, offer, "0.9.82", ""},
		{"signed digest differs", "0.9.82", strings.Repeat("cd", 32), offer, "", "unsigned_target"},
		{"signed version lags", "0.9.81", testSHA, offer, "", "unsigned_target"},
		{"downgrade", "0.9.80", testSHA, &orchestrator.CronWrapperBlock{Action: "update", TargetVersion: "0.9.80", SHA256: testSHA}, "", "downgrade_refused"},
		{"no offer", "0.9.82", testSHA, &orchestrator.CronWrapperBlock{Action: "no_update"}, "", ""},
	}
	for _, tc := range cases {
		u, _ := fixtureUpdater(&fakeUpdaterEnv{}, tc.version, tc.sha, tc.offer)
		target, reason := u.detect(context.Background())
		got := ""
		if target != nil {
			got = target.Version
		}
		if got != tc.want || reason != tc.reason {
			t.Fatalf("%s: target=%q reason=%q, want %q/%q", tc.name, got, reason, tc.want, tc.reason)
		}
	}
}

func TestUpdaterAppliesOnlyWhenNoAgentRuns(t *testing.T) {
	env := &fakeUpdaterEnv{trigger: make(chan struct{}, 1)}
	u, applied := fixtureUpdater(env, "0.9.82", testSHA, &orchestrator.CronWrapperBlock{Action: "update", TargetVersion: "0.9.82", SHA256: testSHA})
	agents := 2
	u.agents = func() int { return agents }
	target := &updateTarget{Version: "0.9.82", SHA256: testSHA}
	if u.tryApply(context.Background(), target) || *applied != 0 {
		t.Fatal("must not apply while agents run")
	}
	if last := env.reports[len(env.reports)-1]; last.State != "waiting_for_quiet" || last.Agents != 2 {
		t.Fatalf("expected waiting_for_quiet(2), got %+v", last)
	}
	agents = 0
	if !u.tryApply(context.Background(), target) || *applied != 1 || env.retired != 1 {
		t.Fatalf("must apply once quiet and retire the on-demand owner (applied=%d retired=%d)", *applied, env.retired)
	}
}

func TestUpdaterLeavesSharedInstallsToRootAndHandsOffResidents(t *testing.T) {
	env := &fakeUpdaterEnv{}
	u, applied := fixtureUpdater(env, "0.9.82", testSHA, nil)
	u.writable = func(string) bool { return false }
	u.tryApply(context.Background(), &updateTarget{Version: "0.9.82", SHA256: testSHA})
	if *applied != 0 || env.reports[len(env.reports)-1].State != "requires_root" {
		t.Fatalf("a non-writable install must not be applied: %+v", env.reports)
	}
	resident := &fakeUpdaterEnv{resident: true}
	u, applied = fixtureUpdater(resident, "0.9.82", testSHA, nil)
	handed := 0
	u.handoff = func(updateTarget, string) error { handed++; return nil }
	u.tryApply(context.Background(), &updateTarget{Version: "0.9.82", SHA256: testSHA})
	if *applied != 1 || handed != 1 || resident.retired != 0 || resident.reports[len(resident.reports)-1].State != "handoff_requested" {
		t.Fatalf("resident: applied=%d handed=%d retired=%d reports=%+v", *applied, handed, resident.retired, resident.reports)
	}
	u.handoff = func(updateTarget, string) error { return errors.New("not installed") }
	u.tryApply(context.Background(), &updateTarget{Version: "0.9.82", SHA256: testSHA})
	if resident.reports[len(resident.reports)-1].Reason != "handoff_request_failed" {
		t.Fatal("a failed handoff request must be reported")
	}
}

func TestUpdaterLoopStagesOnTriggerAndAppliesWhenQuiet(t *testing.T) {
	env := &fakeUpdaterEnv{trigger: make(chan struct{}, 1)}
	u, _ := fixtureUpdater(env, "0.9.82", testSHA, &orchestrator.CronWrapperBlock{Action: "update", TargetVersion: "0.9.82", SHA256: testSHA})
	var applied atomic.Int32
	u.apply = func(context.Context, string) error { applied.Add(1); return nil }
	u.env = &lockedEnv{fakeUpdaterEnv: env}
	agents := 1
	done := make(chan struct{})
	u.agents = func() int {
		select {
		case <-done:
			return 0
		default:
			return agents
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go u.run(ctx)
	env.trigger <- struct{}{}
	time.Sleep(50 * time.Millisecond)
	if applied.Load() != 0 {
		t.Fatal("applied while an agent was running")
	}
	close(done)
	deadline := time.Now().Add(2 * time.Second)
	for applied.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if applied.Load() != 1 {
		t.Fatal("staged update never applied after the host became quiet")
	}
}

type lockedEnv struct {
	*fakeUpdaterEnv
	mu sync.Mutex
}

func (l *lockedEnv) Report(st communicator.UpdateStatus) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.fakeUpdaterEnv.Report(st)
}
func (l *lockedEnv) Retire() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.fakeUpdaterEnv.Retire()
}

func TestUpdaterKeepsTheStagedTargetAcrossATransientApplyFailure(t *testing.T) {
	env := &fakeUpdaterEnv{}
	u, _ := fixtureUpdater(env, "0.9.82", testSHA, nil)
	clock := time.Unix(1_800_000_000, 0)
	u.now = func() time.Time { return clock }
	calls := 0
	u.apply = func(context.Context, string) error {
		calls++
		if calls == 1 {
			return errors.New("maintenance already running")
		}
		return nil
	}
	target := &updateTarget{Version: "0.9.82", SHA256: testSHA}
	if u.tryApply(context.Background(), target) {
		t.Fatal("a transient apply failure must keep the staged target")
	}
	if u.tryApply(context.Background(), target) || calls != 1 {
		t.Fatal("must wait for the retry delay before applying again")
	}
	clock = clock.Add(2 * time.Minute)
	if !u.tryApply(context.Background(), target) || calls != 2 || env.retired != 1 {
		t.Fatalf("retry after the delay must apply (calls=%d retired=%d)", calls, env.retired)
	}
}

func TestUpdaterDropsTheTargetAfterRepeatedApplyFailures(t *testing.T) {
	env := &fakeUpdaterEnv{}
	u, _ := fixtureUpdater(env, "0.9.82", testSHA, nil)
	clock := time.Unix(1_800_000_000, 0)
	u.now = func() time.Time { return clock }
	u.apply = func(context.Context, string) error { return errors.New("broken") }
	target := &updateTarget{Version: "0.9.82", SHA256: testSHA}
	for i := 1; i < maxApplyFailures; i++ {
		if u.tryApply(context.Background(), target) {
			t.Fatalf("dropped after %d failures", i)
		}
		clock = clock.Add(time.Hour)
	}
	if !u.tryApply(context.Background(), target) || env.reports[len(env.reports)-1].Reason != "apply_failed" {
		t.Fatal("must drop and report after the bounded number of failures")
	}
}
