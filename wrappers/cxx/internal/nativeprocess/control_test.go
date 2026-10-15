//go:build linux

package nativeprocess

import (
	"context"
	"os/exec"
	"testing"
	"time"
)

func TestRemoteStopLeavesNeighbourAndReportsOnlyAfterWait(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			neighbour := exec.Command("sleep", "30")
			if err := neighbour.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = neighbour.Process.Kill(); _ = neighbour.Wait() }()
			var stop func() error
			finished := false
			ctx := WithControl(context.Background(), func(fn func() error) func() { stop = fn; return func() { finished = true } })
			cmd := exec.CommandContext(ctx, "sleep", "30")
			supervisor := Prepare(ctx, cmd, true)
			defer supervisor.Close()
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			supervisor.StartControl()
			if err := stop(); err != nil {
				t.Fatal(err)
			}
			if finished {
				t.Fatal("exit reported before Wait")
			}
			_ = cmd.Wait()
			supervisor.Close()
			if !finished {
				t.Fatal("no exit receipt")
			}
			if err := neighbour.Process.Signal(terminateSignal()); err != nil {
				t.Fatalf("neighbour did not survive: %v", err)
			}
		})
	}
}

func TestRemoteStopEscalatesAfterFiveSeconds(t *testing.T) {
	var stop func() error
	ctx := WithControl(context.Background(), func(fn func() error) func() { stop = fn; return func() {} })
	cmd := exec.CommandContext(ctx, "sh", "-c", "trap '' TERM; echo ready; exec sleep 30")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	supervisor := Prepare(ctx, cmd, true)
	defer supervisor.Close()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var ready [6]byte
	if _, err := stdout.Read(ready[:]); err != nil {
		t.Fatal(err)
	}
	supervisor.StartControl()
	start := time.Now()
	if err := stop(); err != nil {
		t.Fatal(err)
	}
	if err := stop(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	supervisor.Close()
	elapsed := time.Since(start)
	if elapsed < 4900*time.Millisecond || elapsed > 8*time.Second {
		t.Fatalf("stop duration %v", elapsed)
	}
}
