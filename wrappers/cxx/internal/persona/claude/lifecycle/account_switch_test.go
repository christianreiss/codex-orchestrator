package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
)

type fakeSwitchPool struct {
	pending *accountpool.SwitchDirective
	dropped []accountpool.SwitchDirective
	wake    chan struct{}
}

func (p *fakeSwitchPool) Pending() *accountpool.SwitchDirective { return p.pending }
func (p *fakeSwitchPool) DropPending(d accountpool.SwitchDirective) {
	p.dropped = append(p.dropped, d)
	p.pending = nil
}
func (p *fakeSwitchPool) SwitchWake() <-chan struct{} { return p.wake }

type codedErr string

func (e codedErr) Error() string     { return string(e) }
func (e codedErr) ErrorCode() string { return string(e) }

type switchRecorder struct {
	steps      []string
	idle       []bool
	flushErr   error
	commitErr  error
	writeSeq   []string // "ok", "cas", "busy"
	matchAfter int
	doneReason string
}

func (r *switchRecorder) deps(pool *fakeSwitchPool) *accountSwitchDeps {
	gen := 0
	return &accountSwitchDeps{
		pool:      pool,
		heartbeat: func(context.Context) error { r.steps = append(r.steps, "heartbeat"); return nil },
		idle: func() bool {
			r.steps = append(r.steps, "idle")
			if len(r.idle) == 0 {
				return true
			}
			v := r.idle[0]
			r.idle = r.idle[1:]
			return v
		},
		flush: func(context.Context) (claude.AuthGeneration, error) {
			r.steps = append(r.steps, "flush")
			gen++
			return claude.AuthGeneration{Exists: true, Digest: strings.Repeat("a", 63) + string(rune('0'+gen))}, r.flushErr
		},
		commit: func(_ context.Context, d accountpool.SwitchDirective) (*accountpool.LeaseResponse, error) {
			r.steps = append(r.steps, "commit")
			if r.commitErr != nil {
				return nil, r.commitErr
			}
			return &accountpool.LeaseResponse{AccountID: d.AccountID, AccountLabel: "b@example.com", Auth: json.RawMessage(`{}`), VerificationState: "verified"}, nil
		},
		apply: func(*accountpool.LeaseResponse) (int64, string, error) {
			r.steps = append(r.steps, "apply")
			return 3, "a@example.com", nil
		},
		write: func(_ context.Context, _ *accountpool.LeaseResponse, expected claude.AuthGeneration) (claude.AuthGeneration, bool, error) {
			outcome := "ok"
			if len(r.writeSeq) > 0 {
				outcome, r.writeSeq = r.writeSeq[0], r.writeSeq[1:]
			}
			r.steps = append(r.steps, "write:"+outcome)
			switch outcome {
			case "busy":
				return claude.AuthGeneration{}, false, errTurnBusy
			case "cas":
				return claude.AuthGeneration{}, false, nil
			}
			return claude.AuthGeneration{Exists: true, Digest: strings.Repeat("b", 64)}, true, nil
		},
		matches: func(context.Context, *accountpool.LeaseResponse) (claude.AuthGeneration, bool) {
			r.steps = append(r.steps, "matches")
			return claude.AuthGeneration{}, false
		},
		pauseSync:  func() { r.steps = append(r.steps, "pause") },
		resumeSync: func() { r.steps = append(r.steps, "resume") },
		done: func(_ int64, _ string, _ *accountpool.LeaseResponse, _ claude.AuthGeneration, reason string) {
			r.steps = append(r.steps, "done")
			r.doneReason = reason
		},
		logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		pollEvery:  time.Hour,
		gateEvery:  time.Millisecond,
		retryEvery: time.Millisecond,
	}
}

func filterSteps(steps []string) string {
	var out []string
	for _, s := range steps {
		if s != "idle" {
			out = append(out, s)
		}
	}
	return strings.Join(out, ",")
}

var directive = accountpool.SwitchDirective{AccountID: 7, BindingGeneration: 4, Reason: "policy"}

func TestPerformAccountSwitchFlushesBeforeCommitAndWrite(t *testing.T) {
	r := &switchRecorder{}
	pool := &fakeSwitchPool{pending: &directive}
	outcome, _, err := performAccountSwitch(context.Background(), r.deps(pool), directive)
	if err != nil || outcome != switchDone {
		t.Fatalf("outcome=%v err=%v", outcome, err)
	}
	if got := filterSteps(r.steps); got != "flush,pause,commit,write:ok,apply,resume,done" {
		t.Fatalf("order: %s", got)
	}
	if r.doneReason != "policy" {
		t.Fatalf("reason: %q", r.doneReason)
	}
}

func TestPerformAccountSwitchWaitsForTurnBoundary(t *testing.T) {
	r := &switchRecorder{idle: []bool{false}}
	outcome, _, _ := performAccountSwitch(context.Background(), r.deps(&fakeSwitchPool{}), directive)
	if outcome != switchRetry || filterSteps(r.steps) != "" {
		t.Fatalf("busy turn: %v %v", outcome, r.steps)
	}
	// A turn that starts during the flush defers the commit.
	r = &switchRecorder{idle: []bool{true, false}}
	outcome, _, _ = performAccountSwitch(context.Background(), r.deps(&fakeSwitchPool{}), directive)
	if outcome != switchRetry || filterSteps(r.steps) != "flush" {
		t.Fatalf("turn during flush: %v %v", outcome, r.steps)
	}
}

func TestPerformAccountSwitchNeverCommitsUnflushedRotation(t *testing.T) {
	r := &switchRecorder{flushErr: errors.New("upload failed")}
	outcome, _, err := performAccountSwitch(context.Background(), r.deps(&fakeSwitchPool{}), directive)
	if outcome != switchRetry || err == nil || strings.Contains(filterSteps(r.steps), "commit") {
		t.Fatalf("flush failure: %v %v %v", outcome, err, r.steps)
	}
}

func TestPerformAccountSwitchDropsStaleDirective(t *testing.T) {
	r := &switchRecorder{commitErr: codedErr("account_switch_stale")}
	pool := &fakeSwitchPool{pending: &directive}
	outcome, _, _ := performAccountSwitch(context.Background(), r.deps(pool), directive)
	if outcome != switchDropped || pool.pending != nil || len(pool.dropped) != 1 {
		t.Fatalf("stale: %v %+v", outcome, pool)
	}
	if got := filterSteps(r.steps); got != "flush,pause,commit,resume" {
		t.Fatalf("stale order: %s", got)
	}
	r = &switchRecorder{commitErr: errors.New("gateway timeout")}
	pool = &fakeSwitchPool{pending: &directive}
	outcome, _, _ = performAccountSwitch(context.Background(), r.deps(pool), directive)
	if outcome != switchRetry || pool.pending == nil {
		t.Fatalf("transient commit failure dropped directive: %v", outcome)
	}
}

func TestPerformAccountSwitchReflushesAfterCASMissAndWaitsOnBusyTurn(t *testing.T) {
	r := &switchRecorder{writeSeq: []string{"busy", "cas", "ok"}}
	outcome, _, err := performAccountSwitch(context.Background(), r.deps(&fakeSwitchPool{}), directive)
	if err != nil || outcome != switchDone {
		t.Fatalf("outcome=%v err=%v", outcome, err)
	}
	if got := filterSteps(r.steps); got != "flush,pause,commit,write:busy,write:cas,matches,flush,write:ok,apply,resume,done" {
		t.Fatalf("order: %s", got)
	}
}

func TestCommittedSwitchKeepsSyncPausedUntilWritten(t *testing.T) {
	cas := make([]string, accountSwitchWrites)
	for i := range cas {
		cas[i] = "cas"
	}
	r := &switchRecorder{writeSeq: append(cas, "ok")}
	pool := &fakeSwitchPool{pending: &directive}
	deps := r.deps(pool)
	outcome, committed, err := performAccountSwitch(context.Background(), deps, directive)
	if outcome != switchIncomplete || committed == nil || err == nil {
		t.Fatalf("first attempt: %v %v %v", outcome, committed, err)
	}
	got := filterSteps(r.steps)
	// The binding follows the server even before the write lands, and sync
	// stays paused: no resume, no notice.
	if !strings.HasPrefix(got, "flush,pause,commit,write:cas,matches,flush") || !strings.HasSuffix(got, ",apply") || strings.Contains(got, "resume") || strings.Contains(got, "done") {
		t.Fatalf("incomplete order: %s", got)
	}
	r.steps = nil
	outcome, committed, err = finishAccountSwitch(context.Background(), deps, committed)
	if outcome != switchDone || committed != nil || err != nil {
		t.Fatalf("retry: %v %v %v", outcome, committed, err)
	}
	if got := filterSteps(r.steps); got != "flush,write:ok,resume,done" {
		t.Fatalf("retry order (apply must not repeat): %s", got)
	}
	// Retries are bounded; giving up resumes sync without a notice.
	r = &switchRecorder{writeSeq: make([]string, 0)}
	deps = r.deps(&fakeSwitchPool{})
	deps.write = func(context.Context, *accountpool.LeaseResponse, claude.AuthGeneration) (claude.AuthGeneration, bool, error) {
		return claude.AuthGeneration{}, false, nil
	}
	c := &committedSwitch{res: &accountpool.LeaseResponse{AccountID: 7}, directive: directive, applied: true, attempts: accountSwitchFinishTries - 1}
	outcome, committed, _ = finishAccountSwitch(context.Background(), deps, c)
	if outcome != switchIncomplete || committed != nil || !strings.HasSuffix(filterSteps(r.steps), "resume") || strings.Contains(filterSteps(r.steps), "done") {
		t.Fatalf("give up: %v %v %v", outcome, committed, r.steps)
	}
}

func TestRunAccountSwitcherPerformsPendingDirective(t *testing.T) {
	r := &switchRecorder{}
	pool := &fakeSwitchPool{pending: &directive, wake: make(chan struct{}, 1)}
	pool.wake <- struct{}{}
	deps := r.deps(pool)
	inner := deps.done
	ctx, cancel := context.WithCancel(context.Background())
	deps.done = func(a int64, b string, res *accountpool.LeaseResponse, g claude.AuthGeneration, reason string) {
		inner(a, b, res, g, reason)
		pool.pending = nil
		cancel()
	}
	finished := make(chan struct{})
	go func() { runAccountSwitcher(ctx, deps); close(finished) }()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("switcher did not perform the directive")
	}
	if got := filterSteps(r.steps); !strings.HasPrefix(got, "heartbeat,flush,pause,commit") {
		t.Fatalf("supervisor order: %s", got)
	}
}

func TestParseSwitchTarget(t *testing.T) {
	for raw, want := range map[string]any{`{"target":"auto"}`: "auto", `{"target":7}`: int64(7)} {
		got, err := parseSwitchTarget(json.RawMessage(raw))
		if err != nil || got != want {
			t.Fatalf("%s: %v %v", raw, got, err)
		}
	}
	for _, raw := range []string{`{}`, `{"target":"best"}`, `{"target":0}`, `{"target":1.5}`, `{"target":"fixture"}`} {
		if _, err := parseSwitchTarget(json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}

func writeTranscript(t *testing.T, dir, name string, lines []string, age time.Duration) {
	t.Helper()
	path := filepath.Join(dir, "project", name+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().Add(-age)
	if err := os.Chtimes(path, stamp, stamp); err != nil {
		t.Fatal(err)
	}
}

func TestScopeTranscriptsQuiet(t *testing.T) {
	ended := []string{
		`{"type":"user","message":{"role":"user","content":"hi"}}`,
		`{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text"}]}}`,
		`{"type":"system","subtype":"turn_duration"}`,
		`{"type":"last-prompt"}`,
	}
	tool := []string{
		`{"type":"user","message":{"role":"user","content":"build"}}`,
		`{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use"}]}}`,
	}
	prompt := []string{
		`{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn"}}`,
		`{"type":"user","message":{"role":"user","content":"next"}}`,
	}
	command := []string{
		`{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn"}}`,
		`{"type":"user","isMeta":true,"message":{"role":"user","content":"caveat"}}`,
		`{"type":"user","message":{"role":"user","content":"<command-name>/status</command-name>"}}`,
	}
	for _, c := range []struct {
		name  string
		lines []string
		age   time.Duration
		quiet bool
	}{
		{"ended and settled", ended, time.Minute, true},
		{"ended but just written", ended, 5 * time.Second, false},
		{"tool running", tool, time.Minute, false},
		{"prompt submitted", prompt, time.Minute, false},
		{"local command only", command, time.Minute, true},
		{"old interrupted session", tool, time.Hour, true},
		{"no conversation yet", []string{`{"type":"mode"}`}, time.Minute, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			writeTranscript(t, dir, "s", c.lines, c.age)
			if got := scopeTranscriptsQuiet(dir, time.Now()); got != c.quiet {
				t.Fatalf("quiet=%v", got)
			}
		})
	}
	dir := t.TempDir()
	writeTranscript(t, dir, "idle", ended, time.Minute)
	writeTranscript(t, dir, "sibling", tool, time.Minute)
	if scopeTranscriptsQuiet(dir, time.Now()) {
		t.Fatal("a sibling's running tool did not block the switch")
	}
}

func TestAccountSwitchNoticeNamesBothAccounts(t *testing.T) {
	text := accountSwitchNotice(3, "a@example.com", 7, "", "agent")
	if !strings.Contains(text, "a@example.com (#3)") || !strings.Contains(text, "#7") || !strings.Contains(text, "reason: agent") || !strings.Contains(text, "Keep working") {
		t.Fatal(text)
	}
}

func TestRestartableAuthWatchRebinds(t *testing.T) {
	starts, stops := 0, 0
	w := &restartableAuthWatch{start: func() func() { starts++; return func() { stops++ } }}
	w.Resume() // never started: nothing to resume
	w.Start()
	w.Pause()
	w.Resume()
	w.Restart()
	w.Stop()
	w.Resume()
	w.Restart()
	if starts != 3 || stops != 3 {
		t.Fatalf("starts=%d stops=%d", starts, stops)
	}
}
