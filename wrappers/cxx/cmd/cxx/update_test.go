package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	ui "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/updateprogress"
)

type updateFixture struct {
	mu                               sync.Mutex
	deps                             hostUpdateDeps
	checks, syncs, installs, reports []string
	versions                         map[string]string
	wrapperInstalls, reexecs         int
}

func newUpdateFixture(t *testing.T, installed ...string) *updateFixture {
	t.Helper()
	old := Version
	Version = "0.9.37"
	t.Cleanup(func() { Version = old })
	for _, key := range []string{"CDX_CODEX_BIN", "CLX_CLAUDE_BIN", "CGX_GROK_BIN"} {
		t.Setenv(key, "")
	}
	f := &updateFixture{versions: map[string]string{"codex": "1.0.0", "claude": "2.0.0", "grok": "3.0.0"}}
	f.deps = hostUpdateDeps{
		resolve: func(engine string) (string, error) {
			for _, name := range installed {
				if engine == name {
					return engine + ".json", nil
				}
			}
			return "", os.ErrNotExist
		},
		load: func(_ context.Context, _, engine string) (*config.Config, error) {
			return &config.Config{Engine: engine}, nil
		},
		check: func(_ context.Context, cfg *config.Config, _ string) (*orchestrator.CronCheckResponse, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.checks = append(f.checks, cfg.Engine)
			return &orchestrator.CronCheckResponse{Action: "no_update", Wrapper: &orchestrator.CronWrapperBlock{Action: "update", TargetVersion: Version}}, nil
		},
		version: func(_ context.Context, engine string) string {
			f.mu.Lock()
			defer f.mu.Unlock()
			return f.versions[engine]
		},
		protect: func(context.Context, *config.Config) error { return nil },
		installWrapper: func(context.Context, *config.Config, *orchestrator.CronWrapperBlock) (string, error) {
			f.wrapperInstalls++
			return "/verified/cxx", nil
		},
		reexec: func(string, string, []string) error { f.reexecs++; return nil },
		install: func(ctx context.Context, engine, target string, _ bool) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.installs = append(f.installs, engine)
			updateprogress.Emit(ctx, updateprogress.Event{Phase: "downloading", Bytes: 50, Total: 100})
			f.versions[engine] = target
			return nil
		},
		sync: func(ctx context.Context, cfg *config.Config) error {
			f.syncs = append(f.syncs, cfg.Engine)
			// Real lifecycle notices must be redirected rather than leak into rows.
			_, _ = updateprogress.Output(ctx, os.Stderr).Write([]byte("unwanted boot panel\n"))
			return nil
		},
		report: func(_ context.Context, cfg *config.Config, _ string) error {
			f.reports = append(f.reports, cfg.Engine)
			return nil
		},
	}
	return f
}

func TestHostUpdateEqualVersionChecksEveryEngineWithoutReplacingWrapper(t *testing.T) {
	f := newUpdateFixture(t, "codex", "claude", "grok")
	var out bytes.Buffer
	if code := updateHost(context.Background(), nil, &out, ui.Caps{}, f.deps, false); code != 0 {
		t.Fatalf("code=%d: %s", code, &out)
	}
	if f.wrapperInstalls != 0 || f.reexecs != 0 || len(f.installs) != 0 {
		t.Fatal("no-op replaced a binary")
	}
	checks := append([]string(nil), f.checks...)
	sort.Strings(checks)
	if strings.Join(checks, ",") != "claude,codex,grok" || strings.Join(f.syncs, ",") != "codex,claude,grok" {
		t.Fatalf("checks=%v syncs=%v", f.checks, f.syncs)
	}
	if len(strings.Split(strings.TrimSpace(out.String()), "\n")) != 4 || !strings.Contains(out.String(), "Grok") || strings.Contains(out.String(), "\x1b") || strings.Contains(out.String(), "unwanted") {
		t.Fatalf("output=%q", out.String())
	}
}

func TestHostUpdateRefreshesAssignmentsBeforeUpdatingEngines(t *testing.T) {
	for _, added := range []string{"codex", "claude", "grok"} {
		t.Run(added, func(t *testing.T) {
			installed := []string{}
			for _, name := range []string{"codex", "claude", "grok"} {
				if name != added {
					installed = append(installed, name)
				}
			}
			f := newUpdateFixture(t, installed...)
			f.versions[added] = ""
			f.deps.assignments = func(_ context.Context, seed *config.Config, _ io.Writer) ([]*config.Config, error) {
				if seed.Engine != installed[0] || len(f.checks) != 0 {
					t.Fatal("assignment refresh did not use the installed seed before update checks")
				}
				return []*config.Config{{Engine: "codex"}, {Engine: "claude"}, {Engine: "grok"}}, nil
			}
			check := f.deps.check
			f.deps.check = func(ctx context.Context, cfg *config.Config, version string) (*orchestrator.CronCheckResponse, error) {
				r, err := check(ctx, cfg, version)
				if cfg.Engine == added {
					r.Action, r.TargetVersion = "update", "4.0.0"
				}
				return r, err
			}
			var out bytes.Buffer
			if code := updateHost(context.Background(), nil, &out, ui.Caps{}, f.deps, false); code != 0 {
				t.Fatalf("code=%d: %s", code, &out)
			}
			if strings.Join(f.installs, ",") != added || strings.Join(f.syncs, ",") != "codex,claude,grok" || !strings.Contains(out.String(), "installed | synced") {
				t.Fatalf("installs=%v syncs=%v output=%s", f.installs, f.syncs, &out)
			}
		})
	}
}

func TestHostUpdateUnassignedSeedAndSuspension(t *testing.T) {
	f := newUpdateFixture(t, "codex", "claude")
	f.deps.assignments = func(_ context.Context, seed *config.Config, _ io.Writer) ([]*config.Config, error) {
		if seed.Engine != "codex" {
			t.Fatal("unexpected seed", seed.Engine)
		}
		return []*config.Config{{Engine: "claude"}, {Engine: "grok", Host: config.Host{FleetDisabledEngines: []string{"grok"}}}}, nil
	}
	var out bytes.Buffer
	if code := updateHost(context.Background(), nil, &out, ui.Caps{}, f.deps, true); code != 0 {
		t.Fatal(code, &out)
	}
	if strings.Join(f.checks, ",") != "claude" || strings.Join(f.syncs, ",") != "claude" || len(f.installs) != 0 || !strings.Contains(out.String(), "suspended fleet-wide") {
		t.Fatalf("checks=%v syncs=%v installs=%v output=%s", f.checks, f.syncs, f.installs, &out)
	}
}

func TestHostUpdateAssignmentFailureStopsMutation(t *testing.T) {
	f := newUpdateFixture(t, "codex", "claude")
	f.deps.assignments = func(context.Context, *config.Config, io.Writer) ([]*config.Config, error) {
		return nil, errors.New("signature invalid")
	}
	var out bytes.Buffer
	if code := updateHost(context.Background(), nil, &out, ui.Caps{}, f.deps, false); code != 1 {
		t.Fatal(code, &out)
	}
	if len(f.checks)+len(f.installs)+len(f.syncs)+f.wrapperInstalls != 0 || !strings.Contains(out.String(), "engine assignment refresh failed: signature invalid") {
		t.Fatalf("unsafe work after uncertain assignment: %s", &out)
	}
}

func TestHostUpdateNativeUpdatesAndKeepsPartialFailureVisible(t *testing.T) {
	f := newUpdateFixture(t, "codex", "claude", "grok")
	check := f.deps.check
	f.deps.check = func(ctx context.Context, cfg *config.Config, version string) (*orchestrator.CronCheckResponse, error) {
		r, err := check(ctx, cfg, version)
		r.Action = "update"
		r.TargetVersion = version[:2] + "1.0"
		return r, err
	}
	f.deps.sync = func(_ context.Context, cfg *config.Config) error {
		f.syncs = append(f.syncs, cfg.Engine)
		if cfg.Engine == "codex" {
			return ipc.ErrHeld
		}
		return nil
	}
	var out bytes.Buffer
	if code := updateHost(context.Background(), nil, &out, ui.Caps{}, f.deps, false); code != 1 {
		t.Fatalf("code=%d", code)
	}
	if len(f.installs) != 3 || len(f.syncs) != 3 || len(f.reports) != 3 {
		t.Fatalf("installs=%v syncs=%v reports=%v", f.installs, f.syncs, f.reports)
	}
	for _, text := range []string{"sync paused: active session", "Claude", "Grok", "updated | synced"} {
		if !strings.Contains(out.String(), text) {
			t.Fatalf("missing %q: %s", text, &out)
		}
	}
}

func TestHostUpdatePolicyAndOverrides(t *testing.T) {
	f := newUpdateFixture(t, "codex", "claude", "grok")
	load := f.deps.load
	f.deps.load = func(ctx context.Context, path, engine string) (*config.Config, error) {
		c, err := load(ctx, path, engine)
		if engine == "grok" {
			c.Host.FleetDisabledEngines = []string{"grok"}
		}
		return c, err
	}
	check := f.deps.check
	f.deps.check = func(ctx context.Context, cfg *config.Config, v string) (*orchestrator.CronCheckResponse, error) {
		r, err := check(ctx, cfg, v)
		if cfg.Engine == "codex" {
			r.Action = "disable"
		} else {
			r.Action = "update"
			r.TargetVersion = "2.1.0"
		}
		return r, err
	}
	t.Setenv("CLX_CLAUDE_BIN", "/custom/claude")
	var out bytes.Buffer
	if code := updateHost(context.Background(), nil, &out, ui.Caps{}, f.deps, false); code != 0 {
		t.Fatalf("code=%d: %s", code, &out)
	}
	if len(f.installs) != 0 || strings.Join(f.checks, ",") != "codex,claude" || strings.Join(f.syncs, ",") != "codex,claude" {
		t.Fatalf("checks=%v installs=%v syncs=%v", f.checks, f.installs, f.syncs)
	}
	for _, text := range []string{"binary updates disabled", "binary override", "suspended fleet-wide"} {
		if !strings.Contains(out.String(), text) {
			t.Fatalf("missing %s", text)
		}
	}
}

func TestHostUpdateWrapperHandoffAndContinuation(t *testing.T) {
	f := newUpdateFixture(t, "grok")
	f.deps.check = func(context.Context, *config.Config, string) (*orchestrator.CronCheckResponse, error) {
		return &orchestrator.CronCheckResponse{Action: "no_update", Wrapper: &orchestrator.CronWrapperBlock{Action: "update", TargetVersion: "0.9.38"}}, nil
	}
	f.deps.reexec = func(exe, target string, args []string) error {
		f.reexecs++
		if exe != "/verified/cxx" || target != "0.9.38" || strings.Join(args, ",") != "--minimal" {
			t.Fatalf("bad handoff %s %s %v", exe, target, args)
		}
		return nil
	}
	var out bytes.Buffer
	if code := updateHost(context.Background(), []string{"--minimal"}, &out, ui.Caps{}, f.deps, false); code != 0 {
		t.Fatalf("code=%d", code)
	}
	if f.wrapperInstalls != 1 || f.reexecs != 1 || len(f.syncs) != 0 {
		t.Fatal("handoff executed remaining work on old code")
	}
	Version = "0.9.38"
	out.Reset()
	if code := updateHost(context.Background(), []string{"--minimal"}, &out, ui.Caps{}, f.deps, true); code != 0 {
		t.Fatalf("code=%d: %s", code, &out)
	}
	if strings.Contains(out.String(), "cxx") || len(f.syncs) != 1 || f.wrapperInstalls != 1 {
		t.Fatalf("duplicated wrapper phase: %s", &out)
	}
}

func TestHostUpdateDowngradeAndCheckFailureDoNotHideHealthyEngines(t *testing.T) {
	for _, target := range []string{"0.9.36", "invalid"} {
		t.Run(target, func(t *testing.T) {
			f := newUpdateFixture(t, "codex", "grok")
			f.deps.check = func(_ context.Context, cfg *config.Config, _ string) (*orchestrator.CronCheckResponse, error) {
				if cfg.Engine == "codex" {
					return nil, errors.New("provider check unavailable")
				}
				return &orchestrator.CronCheckResponse{Action: "no_update", Wrapper: &orchestrator.CronWrapperBlock{Action: "update", TargetVersion: target}}, nil
			}
			var out bytes.Buffer
			if code := updateHost(context.Background(), nil, &out, ui.Caps{}, f.deps, false); code != 1 {
				t.Fatalf("code=%d", code)
			}
			if f.wrapperInstalls != 0 || strings.Join(f.syncs, ",") != "grok" || !strings.Contains(out.String(), "Grok") {
				t.Fatalf("wrong result: %s", &out)
			}
		})
	}
}

func TestHostUpdateGuardStopsBeforeReplacingOrSyncing(t *testing.T) {
	f := newUpdateFixture(t, "claude")
	f.deps.check = func(context.Context, *config.Config, string) (*orchestrator.CronCheckResponse, error) {
		return &orchestrator.CronCheckResponse{Action: "update", TargetVersion: "2.1.0", Wrapper: &orchestrator.CronWrapperBlock{Action: "update", TargetVersion: "0.9.38"}}, nil
	}
	f.deps.protect = func(context.Context, *config.Config) error { return errors.New("pending login unconfirmed") }
	var out bytes.Buffer
	if code := updateHost(context.Background(), nil, &out, ui.Caps{}, f.deps, false); code != 1 {
		t.Fatalf("code=%d", code)
	}
	if f.wrapperInstalls != 0 || len(f.syncs) != 0 || len(f.installs) != 0 {
		t.Fatal("unsafe work after failed credential guard")
	}
}

func TestHostUpdateCancellationAndReportFailure(t *testing.T) {
	f := newUpdateFixture(t, "grok")
	f.deps.report = func(context.Context, *config.Config, string) error { return errors.New("report unavailable") }
	var out bytes.Buffer
	if code := updateHost(context.Background(), nil, &out, ui.Caps{}, f.deps, false); code != 1 || !strings.Contains(out.String(), "version report failed") {
		t.Fatalf("code=%d: %s", code, &out)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out.Reset()
	if code := updateHost(ctx, nil, &out, ui.Caps{}, f.deps, true); code != 1 || !strings.Contains(out.String(), "cancelled") {
		t.Fatalf("code=%d: %s", code, &out)
	}
}

func TestHostUpdateFailedNativeInstallStillSyncsAndContinues(t *testing.T) {
	f := newUpdateFixture(t, "codex", "grok")
	check := f.deps.check
	f.deps.check = func(ctx context.Context, cfg *config.Config, v string) (*orchestrator.CronCheckResponse, error) {
		r, err := check(ctx, cfg, v)
		r.Action, r.TargetVersion = "update", "4.0.0"
		return r, err
	}
	install := f.deps.install
	f.deps.install = func(ctx context.Context, engine, target string, exact bool) error {
		if engine == "codex" {
			return errors.New("download checksum mismatch")
		}
		return install(ctx, engine, target, exact)
	}
	var out bytes.Buffer
	if code := updateHost(context.Background(), nil, &out, ui.Caps{}, f.deps, false); code != 1 {
		t.Fatalf("code=%d", code)
	}
	if strings.Join(f.syncs, ",") != "codex,grok" || len(f.reports) != 2 || !strings.Contains(out.String(), "checksum mismatch | synced") {
		t.Fatalf("partial result: %s", &out)
	}
}

func TestHostUpdateWrapperVerificationAndExecFailuresStopRemainingWork(t *testing.T) {
	for _, stage := range []string{"verification", "exec"} {
		t.Run(stage, func(t *testing.T) {
			f := newUpdateFixture(t, "codex", "claude", "grok")
			check := f.deps.check
			f.deps.check = func(ctx context.Context, cfg *config.Config, v string) (*orchestrator.CronCheckResponse, error) {
				r, err := check(ctx, cfg, v)
				r.Wrapper.TargetVersion = "0.9.38"
				return r, err
			}
			if stage == "verification" {
				f.deps.installWrapper = func(context.Context, *config.Config, *orchestrator.CronWrapperBlock) (string, error) {
					return "", errors.New("checksum mismatch")
				}
			} else {
				f.deps.reexec = func(string, string, []string) error { return errors.New("exec failed") }
			}
			var out bytes.Buffer
			if code := updateHost(context.Background(), nil, &out, ui.Caps{}, f.deps, false); code != 1 {
				t.Fatalf("code=%d", code)
			}
			if len(f.syncs) != 0 || len(f.installs) != 0 || !strings.Contains(out.String(), "Grok") {
				t.Fatalf("unsafe or missing result: %s", &out)
			}
		})
	}
}

func TestHostUpdateReconcilesDaemonWhenAlreadyCurrent(t *testing.T) {
	f := newUpdateFixture(t, "codex", "claude", "grok")
	load := f.deps.load
	f.deps.load = func(ctx context.Context, path, engine string) (*config.Config, error) {
		cfg, err := load(ctx, path, engine)
		cfg.AgentMessaging.Enabled = true
		return cfg, err
	}
	calls := 0
	f.deps.reconcile = func(cfg *config.Config, output io.Writer) {
		calls++
		if len(f.syncs) != 3 {
			t.Fatal("daemon reconciled before engine sync", f.syncs)
		}
		io.WriteString(output, "daemon installation pending\n")
	}
	var out bytes.Buffer
	if code := updateHost(context.Background(), nil, &out, ui.Caps{}, f.deps, false); code != 0 {
		t.Fatal(code, &out)
	}
	if calls != 1 || !strings.Contains(out.String(), "daemon installation pending") {
		t.Fatalf("calls=%d output=%s", calls, &out)
	}
}

// Feedback 5dd116a1: the update must apply the host runtime policy itself
// (retire a worker on a non-persistent host, reconcile the maintenance line)
// instead of leaving it to the next maintenance run.
func TestHostUpdateAppliesRuntimePolicyAfterEngines(t *testing.T) {
	f := newUpdateFixture(t, "codex", "claude")
	calls := 0
	f.deps.policy = func(context.Context, io.Writer) error {
		calls++
		if len(f.syncs) != 2 {
			t.Fatal("policy applied before engine sync", f.syncs)
		}
		return errors.New("crontab unavailable")
	}
	var out bytes.Buffer
	if code := updateHost(context.Background(), nil, &out, ui.Caps{}, f.deps, false); code != 0 {
		t.Fatal("a policy failure must not fail an otherwise successful update", code, &out)
	}
	if calls != 1 || !strings.Contains(out.String(), "host runtime policy: crontab unavailable") {
		t.Fatalf("calls=%d output=%s", calls, &out)
	}
}
