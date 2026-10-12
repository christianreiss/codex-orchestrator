package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	ui "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
)

func parallelUpdateFixture(t *testing.T) *updateFixture {
	f := newUpdateFixture(t, "codex", "claude", "grok")
	check := f.deps.check
	f.deps.check = func(ctx context.Context, cfg *config.Config, version string) (*orchestrator.CronCheckResponse, error) {
		r, err := check(ctx, cfg, version)
		r.Action, r.TargetVersion = "update", "4.0.0"
		return r, err
	}
	return f
}

func TestHostUpdateInstallsOverlapAfterGuardsBeforeSync(t *testing.T) {
	f := parallelUpdateFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	entered := make(chan string, 3)
	release := make(chan struct{})
	var active atomic.Int32
	var guards []string
	f.deps.protect = func(_ context.Context, cfg *config.Config) error { guards = append(guards, cfg.Engine); return nil }
	install := f.deps.install
	f.deps.install = func(ctx context.Context, engine, target string, exact bool) error {
		if len(guards) != 3 {
			return errors.New("installation started before all guards finished")
		}
		active.Add(1)
		defer active.Add(-1)
		entered <- engine
		select {
		case <-release:
			return install(ctx, engine, target, exact)
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	sync := f.deps.sync
	f.deps.sync = func(ctx context.Context, cfg *config.Config) error {
		if active.Load() != 0 {
			return errors.New("sync overlapped installation")
		}
		return sync(ctx, cfg)
	}
	var out bytes.Buffer
	done := make(chan int, 1)
	go func() { done <- updateHost(ctx, nil, &out, ui.Caps{}, f.deps, false) }()
	for i := 0; i < 3; i++ {
		select {
		case <-entered:
		case <-ctx.Done():
			t.Fatal("engine installs did not overlap")
		}
	}
	if active.Load() != 3 {
		t.Fatal("not all installers are running", active.Load())
	}
	close(release)
	if code := <-done; code != 0 {
		t.Fatalf("code=%d: %s", code, &out)
	}
	if strings.Join(guards, ",") != "codex,claude,grok" || strings.Join(f.syncs, ",") != "codex,claude,grok" || strings.Join(f.reports, ",") != "codex,claude,grok" {
		t.Fatalf("guards=%v syncs=%v reports=%v", guards, f.syncs, f.reports)
	}
}

func TestHostUpdateChecksOverlapInWrapperContinuation(t *testing.T) {
	f := newUpdateFixture(t, "codex", "claude", "grok")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	entered := make(chan string, 3)
	release := make(chan struct{})
	check := f.deps.check
	f.deps.check = func(ctx context.Context, cfg *config.Config, v string) (*orchestrator.CronCheckResponse, error) {
		entered <- cfg.Engine
		select {
		case <-release:
			return check(ctx, cfg, v)
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	var out bytes.Buffer
	done := make(chan int, 1)
	go func() { done <- updateHost(ctx, nil, &out, ui.Caps{}, f.deps, true) }()
	for i := 0; i < 3; i++ {
		select {
		case <-entered:
		case <-ctx.Done():
			t.Fatal("engine checks did not overlap")
		}
	}
	close(release)
	if code := <-done; code != 0 {
		t.Fatal(code, &out)
	}
}

func TestHostUpdateCancellationJoinsWorkersAndSkipsSync(t *testing.T) {
	f := parallelUpdateFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	entered := make(chan struct{}, 3)
	var active atomic.Int32
	f.deps.install = func(ctx context.Context, _, _ string, _ bool) error {
		active.Add(1)
		defer active.Add(-1)
		entered <- struct{}{}
		<-ctx.Done()
		return ctx.Err()
	}
	var out bytes.Buffer
	done := make(chan int, 1)
	go func() { done <- updateHost(ctx, nil, &out, ui.Caps{}, f.deps, false) }()
	for i := 0; i < 3; i++ {
		select {
		case <-entered:
		case <-ctx.Done():
			t.Fatal("installers did not start")
		}
	}
	cancel()
	if code := <-done; code != 1 || active.Load() != 0 || len(f.syncs)+len(f.reports) != 0 || strings.Count(out.String(), "cancelled") != 3 {
		t.Fatalf("code=%d active=%d syncs=%v reports=%v output=%s", code, active.Load(), f.syncs, f.reports, &out)
	}
}

func TestHostUpdateGuardFailurePreservesHealthyParallelInstalls(t *testing.T) {
	f := parallelUpdateFixture(t)
	f.deps.protect = func(_ context.Context, cfg *config.Config) error {
		if cfg.Engine == "codex" {
			return errors.New("pending credentials")
		}
		return nil
	}
	var out bytes.Buffer
	if code := updateHost(context.Background(), nil, &out, ui.Caps{}, f.deps, false); code != 1 {
		t.Fatal(code, &out)
	}
	if len(f.installs) != 2 || strings.Join(f.syncs, ",") != "claude,grok" || !strings.Contains(out.String(), "pending credentials | sync skipped") {
		t.Fatalf("installs=%v syncs=%v output=%s", f.installs, f.syncs, &out)
	}
}
