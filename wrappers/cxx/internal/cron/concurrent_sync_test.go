package cron

import (
	"context"
	"io"
	"strings"
	"testing"
)

func TestCoordinatorForwardsGrokConcurrentSyncOverride(t *testing.T) {
	stubCoordinator(t)
	var seen []string
	runEngineTick = func(_ context.Context, _ string, args, _ []string, _, _ io.Writer) error {
		seen = append(seen, strings.Join(args, " "))
		return nil
	}
	if err := runEnabledTicks(WithConcurrentSync(context.Background(), true), "fixture", []string{"codex", "claude", "grok"}, false, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 3 || seen[0] != "codex --cron run" || seen[1] != "claude --cron run" || seen[2] != "grok --cron run --allow-concurrent-sync" {
		t.Fatalf("flags: %v", seen)
	}
}
