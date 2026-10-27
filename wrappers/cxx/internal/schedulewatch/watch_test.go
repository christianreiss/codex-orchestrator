package schedulewatch

import (
	"bytes"
	"context"
	"os/exec"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

func TestAbsentPolicyDoesNotInstallWatch(t *testing.T) {
	if watch(context.Background()) != nil {
		t.Fatal("default enabled")
	}
}
func TestNativeOutputUpdatesProgress(t *testing.T) {
	ctx := WithPolicy(context.Background(), nil)
	w := watch(ctx)
	w.last = time.Now().Add(-time.Hour)
	var out bytes.Buffer
	_, err := Writer(ctx, &out).Write([]byte("native event"))
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(w.last) > time.Second {
		t.Fatal("progress not observed")
	}
	if out.String() != "native event" {
		t.Fatal("output changed")
	}
}

func TestWatchdogStopsOnlyExplicitlyAuthorizedOwnedChild(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("native /proc activity required")
	}
	prior := pollInterval
	pollInterval = 20 * time.Millisecond
	defer func() { pollInterval = prior }()
	ctx := WithPolicy(context.Background(), func(context.Context) (Policy, error) { return Policy{TimeoutSeconds: 1, BindingGeneration: 1}, nil })
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	stop := Start(ctx, cmd)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait(); stop() }()
	select {
	case <-done:
		t.Fatal("stopped before timeout")
	case <-time.After(100 * time.Millisecond):
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("sleep was not terminated")
		}
	case <-time.After(3 * time.Second):
		cmd.Process.Kill()
		t.Fatal("hung child was not stopped")
	}
}
func TestRevokedPolicyAndQuietChildToolsPreventTermination(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("native /proc activity required")
	}
	prior := pollInterval
	pollInterval = 20 * time.Millisecond
	defer func() { pollInterval = prior }()
	for _, tc := range []struct {
		name, program string
		args          []string
		timeout       int
	}{
		{"revoked", "sleep", []string{"30"}, 0},
		{"quiet-tool", "sh", []string{"-c", "sleep 2; wait"}, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := WithPolicy(context.Background(), func(context.Context) (Policy, error) {
				return Policy{TimeoutSeconds: tc.timeout, BindingGeneration: 1}, nil
			})
			cmd := exec.Command(tc.program, tc.args...)
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			stop := Start(ctx, cmd)
			done := make(chan error, 1)
			go func() { done <- cmd.Wait(); stop() }()
			select {
			case <-done:
				t.Fatal("protected child terminated")
			case <-time.After(1300 * time.Millisecond):
			}
			cmd.Process.Kill()
			<-done
		})
	}
}

func TestCapacityErrorsRequireStructuredFailureAndHandleChunking(t *testing.T) {
	for _, raw := range []string{`{"type":"assistant","text":"model at capacity"}`, `{"type":"error","message":"invalid key"}`, `{"type":"result","is_error":false,"result":"rate_limit"}`} {
		if CapacityFailure([]byte(raw)) {
			t.Fatal("false recovery trigger", raw)
		}
	}
	ctx := WithPolicy(context.Background(), nil)
	calls := 0
	WithReporter(ctx, func(_ context.Context, _ time.Time, failure string) error {
		if failure == "capacity" {
			calls++
		}
		return nil
	})
	var out bytes.Buffer
	writer := Writer(ctx, &out)
	writer.Write([]byte(`{"type":"error","message":"Model at `))
	if calls != 0 {
		t.Fatal("partial event")
	}
	writer.Write([]byte("capacity\"}\n"))
	if calls != 1 {
		t.Fatal("split error lost", calls)
	}
	w := watch(ctx)
	before := w.progress
	w.last = time.Now().Add(-time.Hour)
	reset(ctx)
	if !w.progress.Equal(before) {
		t.Fatal("policy grace counted as progress")
	}
}
func TestFreshRevocationPreventsForcedTermination(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("proc required")
	}
	prior := pollInterval
	pollInterval = 20 * time.Millisecond
	defer func() { pollInterval = prior }()
	reads := 0
	ctx := WithPolicy(context.Background(), func(context.Context) (Policy, error) {
		reads++
		if reads < 3 {
			return Policy{TimeoutSeconds: 60, BindingGeneration: 1, TerminateRequested: true}, nil
		}
		return Policy{}, nil
	})
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	stop := Start(ctx, cmd)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait(); stop() }()
	select {
	case <-done:
		t.Fatal("fresh revoke ignored")
	case <-time.After(150 * time.Millisecond):
	}
	cmd.Process.Kill()
	<-done
}

func TestSiblingLeaderToolProtectsQuietTUI(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("native /proc activity required")
	}
	prior := pollInterval
	pollInterval = 20 * time.Millisecond
	defer func() { pollInterval = prior }()
	leader := exec.Command("sh", "-c", "sleep 0.7; wait")
	if err := leader.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = leader.Process.Kill(); _ = leader.Wait() }()
	ctx := WithPolicy(context.Background(), func(context.Context) (Policy, error) {
		return Policy{TimeoutSeconds: 60, BindingGeneration: 1, TerminateRequested: true}, nil
	})
	ctx = WithActivity(ctx, leader)
	tui := exec.Command("sleep", "30")
	if err := tui.Start(); err != nil {
		t.Fatal(err)
	}
	defer tui.Process.Kill()
	stop := Start(ctx, tui)
	done := make(chan error, 1)
	go func() { done <- tui.Wait(); stop() }()
	select {
	case err := <-done:
		t.Fatalf("leader's running tool failed to protect TUI: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("authorized idle TUI was not terminated")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("finished leader tool blocked termination forever")
	}
}

func TestNoTimeoutPolicyIsNotReReadEveryTick(t *testing.T) {
	prior := pollInterval
	pollInterval = 5 * time.Millisecond
	defer func() { pollInterval = prior }()
	var reads atomic.Int32
	ctx := WithPolicy(context.Background(), func(context.Context) (Policy, error) {
		reads.Add(1)
		return Policy{}, nil
	})
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	stop := Start(ctx, cmd)
	time.Sleep(100 * time.Millisecond)
	stop()
	if got := reads.Load(); got != 1 {
		t.Fatalf("policy reads = %d over ~20 ticks, want 1", got)
	}
}

func TestSupervisorDoesNotKillAnUnconfirmedProcessAfterGrace(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("proc required")
	}
	prior, grace := pollInterval, supervisorStopGrace
	pollInterval, supervisorStopGrace = 20*time.Millisecond, 60*time.Millisecond
	defer func() { pollInterval, supervisorStopGrace = prior, grace }()
	var blocked atomic.Bool
	// This shell has no child tools; it deliberately ignores TERM while blocked in read.
	cmd := exec.Command("sh", "-c", `trap '' TERM; echo ready; read x`)
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	ctx := WithPolicy(context.Background(), func(context.Context) (Policy, error) {
		return Policy{TimeoutSeconds: 60, BindingGeneration: 1, TerminateRequested: true, Supervisor: true}, nil
	})
	WithReporter(ctx, func(_ context.Context, _ time.Time, failure string) error {
		if failure == "termination_unconfirmed" {
			blocked.Store(true)
		}
		return nil
	})
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	ready := make([]byte, 6)
	if _, err = out.Read(ready); err != nil {
		t.Fatal(err)
	}
	stop := Start(ctx, cmd)
	defer stop()
	deadline := time.Now().Add(time.Second)
	for !blocked.Load() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked.Load() {
		t.Fatal("unconfirmed exit was not escalated")
	}
	// A killed shell cannot accept input and print again.
	if _, err = in.Write([]byte("continue\n")); err != nil {
		t.Fatal("supervisor killed the unconfirmed process", err)
	}
}
