package accountgate

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func gateDir(t *testing.T) string {
	t.Helper()
	dir := Dir(t.TempDir(), "lease")
	if err := Prepare(dir); err != nil {
		t.Fatal(err)
	}
	old := holdPoll
	holdPoll = 5 * time.Millisecond
	t.Cleanup(func() { holdPoll = old })
	return dir
}

func phase(t *testing.T, dir, session, agent string) string {
	t.Helper()
	thread, ok := readThread(threadPath(dir, session, agent))
	if !ok {
		return ""
	}
	return thread.Phase
}

func in(event, agent string) HookInput {
	return HookInput{Event: event, SessionID: "s1", AgentID: agent}
}

func TestHookRecordsPhasePerEvent(t *testing.T) {
	dir := gateDir(t)
	if Ready(dir) {
		t.Fatal("ready before any hook ran")
	}
	steps := []struct {
		in   HookInput
		want string
	}{
		{HookInput{Event: "SessionStart", SessionID: "s1", Source: "startup"}, PhaseIdle},
		{in("UserPromptSubmit", ""), PhaseModel},
		{in("PreToolUse", ""), PhaseTool},
		{in("PostToolBatch", ""), PhaseModel},
		{HookInput{Event: "SessionStart", SessionID: "s1", Source: "compact"}, PhaseModel},
		{in("PreCompact", ""), PhaseModel},
		{in("Stop", ""), PhaseIdle},
		{in("UserPromptSubmit", ""), PhaseModel},
		{in("StopFailure", ""), PhaseIdle},
	}
	for _, step := range steps {
		if held := Hook(dir, step.in); held != 0 {
			t.Fatalf("%s held %v without a pause", step.in.Event, held)
		}
		if got := phase(t, dir, "s1", ""); got != step.want {
			t.Fatalf("after %s (%s): phase %q, want %q", step.in.Event, step.in.Source, got, step.want)
		}
	}
	if !Ready(dir) {
		t.Fatal("a hook ran but the session is not marked ready")
	}
	Hook(dir, in("SubagentStart", "a1"))
	if got := phase(t, dir, "s1", "a1"); got != PhaseModel {
		t.Fatalf("subagent phase %q", got)
	}
	Hook(dir, in("SubagentStop", "a1"))
	if got := phase(t, dir, "s1", "a1"); got != "" {
		t.Fatalf("subagent thread kept after SubagentStop: %q", got)
	}
	Hook(dir, in("SessionEnd", ""))
	if len(Threads(dir)) != 0 {
		t.Fatalf("threads left after SessionEnd: %v", Threads(dir))
	}
}

func TestHookIgnoresLaunchWithoutGateDirectory(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "gone.gate")
	if held := Hook(missing, in("UserPromptSubmit", "")); held != 0 {
		t.Fatal("held without a directory")
	}
	if _, err := os.Stat(missing); err == nil {
		t.Fatal("a hook must not create the gate directory of an ended launch")
	}
}

// A second session that inherited the environment must not overwrite the
// parent's root thread.
func TestThreadsAreKeyedBySessionAndAgent(t *testing.T) {
	dir := gateDir(t)
	Hook(dir, in("UserPromptSubmit", ""))
	Hook(dir, HookInput{Event: "Stop", SessionID: "nested"})
	if got := phase(t, dir, "s1", ""); got != PhaseModel {
		t.Fatalf("parent root phase %q after a nested session's Stop", got)
	}
	if got := phase(t, dir, "nested", ""); got != PhaseIdle {
		t.Fatalf("nested root phase %q", got)
	}
}

func TestHoldEndsOnReleaseDeadlineAndDeadOwner(t *testing.T) {
	t.Run("release", func(t *testing.T) {
		dir := gateDir(t)
		if err := Activate(dir, Pause{Round: "r1", Deadline: time.Now().Add(time.Minute)}); err != nil {
			t.Fatal(err)
		}
		done := make(chan time.Duration, 1)
		go func() { done <- Hook(dir, in("PostToolBatch", "")) }()
		deadline := time.Now().Add(2 * time.Second)
		for phase(t, dir, "s1", "") != PhaseHeld {
			if time.Now().After(deadline) {
				t.Fatal("hook never reached the held phase")
			}
			time.Sleep(2 * time.Millisecond)
		}
		select {
		case <-done:
			t.Fatal("hook returned while the pause was active")
		case <-time.After(40 * time.Millisecond):
		}
		if safe, why := Safe(dir, "r1", time.Now()); !safe {
			t.Fatalf("a held session is not safe: %s", why)
		}
		Release(dir)
		select {
		case held := <-done:
			if held <= 0 {
				t.Fatal("hold duration not reported")
			}
		case <-time.After(2 * time.Second):
			t.Fatal("hook did not return after release")
		}
		if got := phase(t, dir, "s1", ""); got != PhaseModel {
			t.Fatalf("phase %q after a released hold, want model", got)
		}
	})
	t.Run("deadline", func(t *testing.T) {
		dir := gateDir(t)
		if err := Activate(dir, Pause{Round: "r1", Deadline: time.Now().Add(60 * time.Millisecond)}); err != nil {
			t.Fatal(err)
		}
		started := time.Now()
		Hook(dir, in("UserPromptSubmit", ""))
		if waited := time.Since(started); waited < 40*time.Millisecond || waited > 2*time.Second {
			t.Fatalf("held %v for a 60 ms deadline", waited)
		}
	})
	t.Run("dead owner", func(t *testing.T) {
		dir := gateDir(t)
		// PID 0 is replaced by the caller's; an impossible PID is a dead owner.
		if err := Activate(dir, Pause{Round: "r1", Deadline: time.Now().Add(time.Minute), OwnerPID: 1 << 30}); err != nil {
			t.Fatal(err)
		}
		if held := Hook(dir, in("UserPromptSubmit", "")); held != 0 {
			t.Fatalf("held %v for a pause whose owner is gone", held)
		}
	})
}

// A paused session's tools finish during the round and their hooks arrive at
// the gate one after another. None of them may show "model" on the way in.
func TestHookEnteringAnActivePauseNeverLooksLikeAModelRequest(t *testing.T) {
	dir := gateDir(t)
	Hook(dir, in("UserPromptSubmit", ""))
	Hook(dir, in("PreToolUse", ""))
	Hook(dir, in("SubagentStart", "a1"))
	Hook(dir, in("PreToolUse", "a1"))
	_ = Activate(dir, Pause{Round: "r1", Deadline: time.Now().Add(time.Minute)})
	if safe, why := Safe(dir, "r1", time.Now()); !safe {
		t.Fatalf("both threads run tools: %s", why)
	}
	stop := make(chan struct{})
	unsafe := make(chan string, 1)
	watching := make(chan struct{})
	go func() {
		defer close(watching)
		for {
			select {
			case <-stop:
				return
			default:
			}
			if safe, why := Safe(dir, "r1", time.Now()); !safe {
				select {
				case unsafe <- why:
				default:
				}
				return
			}
		}
	}()
	var wg sync.WaitGroup
	for _, agent := range []string{"", "a1"} {
		for _, event := range []string{"PostToolBatch", "PreCompact"} {
			wg.Add(1)
			go func() { defer wg.Done(); Hook(dir, in(event, agent)) }()
		}
	}
	deadline := time.Now().Add(2 * time.Second)
	for phase(t, dir, "s1", "") != PhaseHeld || phase(t, dir, "s1", "a1") != PhaseHeld {
		if time.Now().After(deadline) {
			t.Fatal("the hooks never reached the gate")
		}
		time.Sleep(time.Millisecond)
	}
	time.Sleep(30 * time.Millisecond)
	close(stop)
	<-watching
	select {
	case why := <-unsafe:
		t.Fatalf("a thread entering the gate looked unsafe: %s", why)
	default:
	}
	Release(dir)
	wg.Wait()
	// Released, each thread goes on to its model request and says so.
	if phase(t, dir, "s1", "") != PhaseModel || phase(t, dir, "s1", "a1") != PhaseModel {
		t.Fatalf("after release: root=%s subagent=%s", phase(t, dir, "s1", ""), phase(t, dir, "s1", "a1"))
	}
}

// The pause ends between the hook's two looks at the gate: it is not held,
// and it must still record that the thread went on.
func TestHookRecordsModelWhenThePauseEndsUnderIt(t *testing.T) {
	dir := gateDir(t)
	Hook(dir, in("UserPromptSubmit", ""))
	Hook(dir, in("PreToolUse", ""))
	// An active pause whose deadline passes at once.
	_ = Activate(dir, Pause{Round: "r1", Deadline: time.Now().Add(time.Millisecond)})
	clockCalls := 0
	start := time.Now()
	// The first look sees the pause; every later one is past its deadline.
	clock := func() time.Time {
		clockCalls++
		if clockCalls == 1 {
			return start
		}
		return start.Add(time.Second)
	}
	if held := hook(dir, in("PostToolBatch", ""), clock); held != 0 {
		t.Fatalf("held %v for a pause that was over", held)
	}
	if got := phase(t, dir, "s1", ""); got != PhaseModel {
		t.Fatalf("phase %q: the thread went on without saying so", got)
	}
}

func TestActivateNeverExtendsARound(t *testing.T) {
	dir := gateDir(t)
	first := time.Now().Add(30 * time.Second).Truncate(time.Millisecond)
	_ = Activate(dir, Pause{Round: "r1", Deadline: first})
	_ = Activate(dir, Pause{Round: "r1", Deadline: first.Add(time.Hour)})
	if p, _ := Active(dir, time.Now()); !p.Deadline.Equal(first) {
		t.Fatalf("deadline moved to %v", p.Deadline)
	}
	_ = Activate(dir, Pause{Round: "r2", Deadline: first.Add(time.Hour)})
	if p, _ := Active(dir, time.Now()); p.Round != "r2" || !p.Deadline.Equal(first.Add(time.Hour)) {
		t.Fatalf("a new round did not replace the pause: %+v", p)
	}
}

func TestToolsAreNotHeldAndStopIs(t *testing.T) {
	dir := gateDir(t)
	_ = Activate(dir, Pause{Round: "r1", Deadline: time.Now().Add(80 * time.Millisecond)})
	if held := Hook(dir, in("PreToolUse", "")); held != 0 {
		t.Fatalf("PreToolUse held %v", held)
	}
	if held := Hook(dir, in("Stop", "")); held <= 0 {
		t.Fatal("Stop was not held while a pause was active")
	}
}

func TestSafeNeedsEveryThreadOutOfTheModel(t *testing.T) {
	dir := gateDir(t)
	now := time.Now()
	if safe, _ := Safe(dir, "", now); safe {
		t.Fatal("safe without a pause")
	}
	Hook(dir, in("UserPromptSubmit", ""))
	Hook(dir, in("PreToolUse", ""))
	Hook(dir, in("SubagentStart", "a1"))
	_ = Activate(dir, Pause{Round: "r1", Deadline: now.Add(time.Minute)})
	if safe, why := Safe(dir, "r1", time.Now()); safe {
		t.Fatal("safe while a subagent is in a model request")
	} else if why == "" {
		t.Fatal("no blocker named")
	}
	if safe, _ := Safe(dir, "other", time.Now()); safe {
		t.Fatal("safe for a round the session is not paused for")
	}
	Hook(dir, in("PreToolUse", "a1"))
	if safe, why := Safe(dir, "r1", time.Now()); !safe {
		t.Fatalf("root and subagent run tools, but: %s", why)
	}
	// A model phase nothing has confirmed for ten minutes blocks no round.
	setPhase(dir, in("PostToolBatch", "a1"), PhaseModel, now.Add(-modelStale-time.Second))
	if safe, why := Safe(dir, "r1", time.Now()); !safe {
		t.Fatalf("stale model phase blocks: %s", why)
	}
}

func TestInterruptedTurnIsSafe(t *testing.T) {
	dir := gateDir(t)
	transcript := filepath.Join(t.TempDir(), "t.jsonl")
	write := func(lines string) {
		if err := os.WriteFile(transcript, []byte(lines), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	prompt := HookInput{Event: "UserPromptSubmit", SessionID: "s1", TranscriptPath: transcript}
	_ = Activate(dir, Pause{Round: "r1", Deadline: time.Now().Add(20 * time.Millisecond)})
	write(`{"type":"user","message":{"content":"write an essay"}}` + "\n" + `{"type":"assistant","message":{"content":[{"type":"text","text":"The"}]}}` + "\n")
	Hook(dir, prompt)
	_ = Activate(dir, Pause{Round: "r2", Deadline: time.Now().Add(time.Minute)})
	if safe, _ := Safe(dir, "r2", time.Now()); safe {
		t.Fatal("a streaming turn counted as safe")
	}
	write(`{"type":"user","message":{"content":"write an essay"}}` + "\n" + `{"type":"assistant","message":{"content":[{"type":"text","text":"The"}]}}` + "\n" +
		`{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}` + "\n" + `{"type":"system","subtype":"x"}` + "\n")
	if safe, why := Safe(dir, "r2", time.Now()); !safe {
		t.Fatalf("an interrupted turn blocks: %s", why)
	}
}

// The hook that blocks a Stop and the gate's own Stop hook run side by side.
func TestBlockedStopIsRecordedAsModelInEitherOrder(t *testing.T) {
	t.Run("gate first", func(t *testing.T) {
		dir := gateDir(t)
		Hook(dir, in("UserPromptSubmit", ""))
		Hook(dir, in("Stop", ""))
		Continue(dir, "s1", "")
		if got := phase(t, dir, "s1", ""); got != PhaseModel {
			t.Fatalf("phase %q", got)
		}
		// The continuation ends with an ordinary Stop.
		Hook(dir, in("Stop", ""))
		if got := phase(t, dir, "s1", ""); got != PhaseIdle {
			t.Fatalf("phase %q after the continuation ended", got)
		}
	})
	t.Run("blocker first", func(t *testing.T) {
		dir := gateDir(t)
		Hook(dir, in("UserPromptSubmit", ""))
		Continue(dir, "s1", "")
		Hook(dir, in("Stop", ""))
		if got := phase(t, dir, "s1", ""); got != PhaseModel {
			t.Fatalf("phase %q", got)
		}
		Hook(dir, in("Stop", ""))
		if got := phase(t, dir, "s1", ""); got != PhaseIdle {
			t.Fatalf("phase %q after the continuation ended", got)
		}
	})
	t.Run("held stop", func(t *testing.T) {
		dir := gateDir(t)
		Hook(dir, in("UserPromptSubmit", ""))
		_ = Activate(dir, Pause{Round: "r1", Deadline: time.Now().Add(time.Minute)})
		done := make(chan struct{})
		go func() { Hook(dir, in("Stop", "")); close(done) }()
		for phase(t, dir, "s1", "") != PhaseHeld {
			time.Sleep(2 * time.Millisecond)
		}
		Continue(dir, "s1", "")
		Release(dir)
		<-done
		if got := phase(t, dir, "s1", ""); got != PhaseModel {
			t.Fatalf("phase %q after a held Stop that was blocked", got)
		}
	})
}

func TestParallelHooksOfOneThread(t *testing.T) {
	dir := gateDir(t)
	Hook(dir, in("UserPromptSubmit", ""))
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); Hook(dir, in("PreToolUse", "")) }()
	}
	wg.Wait()
	if got := phase(t, dir, "s1", ""); got != PhaseTool {
		t.Fatalf("phase %q after parallel PreToolUse hooks", got)
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".tmp" {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}
}
