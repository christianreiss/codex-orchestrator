package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentbus"
	"io"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	claudeapp "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/app/claude"
	codexapp "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/app/codex"
	grokapp "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/app/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	hostcron "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/cron"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/maintenance"
	claudelifecycle "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/lifecycle"
	codexlifecycle "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/lifecycle"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	personaUpdate "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/update"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	ui "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/terminalui"
	coreupdate "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/updateprogress"
)

const updateHandoffEnv = "CXX_UPDATE_WRAPPER_DONE"

// These adapters keep orchestration testable without installing or launching a CLI.
type hostUpdateDeps struct {
	resolve        func(string) (string, error)
	load           func(context.Context, string, string) (*config.Config, error)
	assignments    func(context.Context, *config.Config, io.Writer) ([]*config.Config, error)
	check          func(context.Context, *config.Config, string) (*orchestrator.CronCheckResponse, error)
	version        func(context.Context, string) string
	protect        func(context.Context, *config.Config) error
	installWrapper func(context.Context, *config.Config, *orchestrator.CronWrapperBlock) (string, error)
	reexec         func(string, string, []string) error
	install        func(context.Context, string, string, bool) error
	sync           func(context.Context, *config.Config) error
	report         func(context.Context, *config.Config, string) error
	reconcile      func(*config.Config, io.Writer)
	// policy applies docs/host-runtime-policy.md right after an update, so a
	// retired worker or a 15-minute cron line does not outlive the binary that
	// installed it until the next maintenance run (feedback 5dd116a1).
	policy func(context.Context, io.Writer) error
}

type engineUpdate struct {
	name     string
	cfg      *config.Config
	loadErr  error
	check    *orchestrator.CronCheckResponse
	checkErr error
}

func runHostUpdate(args []string, stdout, stderr io.Writer) int {
	minimal := false
	for _, arg := range args {
		switch arg {
		case "--minimal", "--minimal-output", "--silent", "--skip-boot", "--no-banner":
			minimal = true
		default:
			fmt.Fprintf(stderr, "cxx update: unknown argument %q\n", arg)
			return 2
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 12*time.Minute)
	defer cancel()
	lease, err := maintenance.Begin(ctx, false)
	if err != nil {
		fmt.Fprintln(stderr, "cxx update:", err)
		return 1
	}
	var runErr error
	defer func() { _ = lease.Finish(runErr) }()
	deps := defaultHostUpdateDeps()
	reexec := deps.reexec
	deps.reexec = func(exe, target string, argv []string) error {
		// The new process acquires a fresh coordinator lease. Never carry the
		// old maintenance lock across exec, which would block its continuation.
		if err := lease.Finish(nil); err != nil {
			return err
		}
		return reexec(exe, target, argv)
	}
	caps := ui.DetectCapsFor(stderr, "")
	if minimal {
		caps = ui.MinimalCaps(caps)
	}
	continued := os.Getenv(updateHandoffEnv) == Version
	code := updateHost(ctx, args, stderr, caps, deps, continued)
	if code != 0 {
		runErr = errors.New("host update incomplete")
	}
	if err := lease.Finish(runErr); err != nil {
		fmt.Fprintln(stderr, "cxx update:", err)
		return 1
	}
	return code
}

func updateHost(ctx context.Context, args []string, w io.Writer, caps ui.Caps, deps hostUpdateDeps, continued bool) int {
	quietCtx := updateprogress.WithOutput(ctx, io.Discard)
	var wrapperRow *ui.UpdateRow
	if !continued {
		wrapperRow = ui.StartUpdateRow(w, caps, "cxx", Version)
	}
	var engines []engineUpdate
	for _, name := range []string{"codex", "claude", "grok"} {
		path, err := deps.resolve(name)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		e := engineUpdate{name: name, loadErr: err}
		if err == nil {
			e.cfg, e.loadErr = deps.load(quietCtx, path, name)
		}
		engines = append(engines, e)
	}
	if len(engines) == 0 {
		if wrapperRow != nil {
			wrapperRow.Finish(ui.ToneFail, Version, "no installed engine config found")
		} else {
			fmt.Fprintln(w, "cxx update: no installed engine config found")
		}
		return 1
	}
	if deps.assignments != nil {
		var seed *config.Config
		for _, e := range engines {
			if e.loadErr == nil {
				seed = e.cfg
				break
			}
		}
		var configs []*config.Config
		err := errors.New("no usable signed engine config found")
		if seed != nil {
			configs, err = deps.assignments(quietCtx, seed, io.Discard)
		}
		if err == nil && len(configs) == 0 {
			err = errors.New("no assigned engine config found")
		}
		if err != nil {
			status := "engine assignment refresh failed: " + err.Error()
			if wrapperRow != nil {
				wrapperRow.Finish(ui.ToneFail, Version, status)
			} else {
				fmt.Fprintln(w, "cxx update:", status)
			}
			return 1
		}
		engines = nil
		for _, cfg := range configs {
			engines = append(engines, engineUpdate{name: cfg.Engine, cfg: cfg})
		}
	}

	worst := 0
	if !continued {
		row := wrapperRow
		wrapperCtx := updateprogress.WithObserver(quietCtx, row.Observe)
		var seed *engineUpdate
		for i := range engines {
			e := &engines[i]
			if e.loadErr == nil && !e.cfg.EngineSuspended(e.name) {
				e.check, e.checkErr = deps.check(wrapperCtx, e.cfg, deps.version(ctx, e.name))
				if e.checkErr == nil && e.check == nil {
					e.checkErr = errors.New("empty update check response")
				}
				if e.checkErr == nil {
					seed = e
					break
				}
			}
		}
		if seed == nil {
			allSuspended := true
			for _, e := range engines {
				allSuspended = allSuspended && e.loadErr == nil && e.cfg.EngineSuspended(e.name)
			}
			if allSuspended {
				row.Finish(ui.ToneWarn, Version, "skipped: all engines suspended")
			} else {
				row.Finish(ui.ToneFail, Version, "check failed; see engine results")
				worst = 1
			}
		} else {
			wrapper := seed.check.Wrapper
			switch {
			case seed.check.Action == "disable":
				row.Finish(ui.ToneWarn, Version, "skipped: binary updates disabled")
			case wrapper == nil || wrapper.Action != "update":
				row.Finish(ui.ToneOK, Version, "up to date")
			default:
				cmp, err := coreupdate.CompareVersions(wrapper.TargetVersion, Version)
				if err == nil && cmp == 0 {
					row.Finish(ui.ToneOK, Version, "up to date")
				} else if err != nil || cmp < 0 {
					if err == nil {
						err = fmt.Errorf("refusing downgrade to %s", wrapper.TargetVersion)
					}
					row.Finish(ui.ToneFail, Version, err.Error())
					worst = 1
				} else {
					row.SetVersion(Version + " → " + wrapper.TargetVersion)
					err := protectHostUpdate(wrapperCtx, engines, deps)
					exe := ""
					if err == nil {
						exe, err = deps.installWrapper(wrapperCtx, seed.cfg, wrapper)
					}
					if err == nil {
						err = protectHostUpdate(wrapperCtx, engines, deps)
					}
					if err != nil {
						status := "update failed: " + err.Error()
						if exe != "" {
							status = "installed; restart deferred: " + err.Error()
						}
						row.Finish(ui.ToneFail, Version, status)
						// Do not sync away unconfirmed native credentials or run
						// installers with old code after a failed wrapper handoff.
						skipUpdateEngines(w, caps, engines, "wrapper update failed")
						return 1
					}
					row.Finish(ui.ToneOK, Version+" → "+wrapper.TargetVersion, "updated · restarting")
					if err := deps.reexec(exe, wrapper.TargetVersion, args); err != nil {
						fmt.Fprintln(w, "cxx update: wrapper installed; continuation failed:", err)
						skipUpdateEngines(w, caps, engines, "wrapper continuation failed")
						return 1
					}
					return 0 // successful exec never returns
				}
			}
		}
	}
	if updateEngines(quietCtx, w, caps, engines, deps) != 0 {
		worst = 1
	}
	// Reconcile once with visible output even when the wrapper was already
	// current. Per-engine sync uses quiet output for its compact update rows.
	if deps.reconcile != nil && ctx.Err() == nil {
		for _, e := range engines {
			if e.loadErr == nil && e.cfg.AgentMessaging.Enabled && !e.cfg.EngineSuspended(e.name) {
				deps.reconcile(e.cfg, w)
				break
			}
		}
	}
	if deps.policy != nil && ctx.Err() == nil {
		if err := deps.policy(ctx, w); err != nil {
			fmt.Fprintln(w, "cxx update: host runtime policy:", err)
		}
	}
	return worst
}

func skipUpdateEngines(w io.Writer, caps ui.Caps, engines []engineUpdate, reason string) {
	for _, e := range engines {
		row := ui.StartUpdateRow(w, caps, config.EngineLabel(e.name), "")
		row.Finish(ui.ToneWarn, "", "skipped: "+reason)
	}
}

func protectHostUpdate(ctx context.Context, engines []engineUpdate, deps hostUpdateDeps) error {
	for _, e := range engines {
		if e.loadErr != nil {
			return fmt.Errorf("cannot preserve %s credentials: %w", e.name, e.loadErr)
		}
		if e.cfg.EngineSuspended(e.name) {
			continue
		}
		if err := deps.protect(ctx, e.cfg); err != nil {
			return err
		}
	}
	return nil
}

func nativeOverride(engine string) bool {
	return strings.TrimSpace(os.Getenv(map[string]string{"codex": "CDX_CODEX_BIN", "claude": "CLX_CLAUDE_BIN", "grok": "CGX_GROK_BIN"}[engine])) != ""
}

func updateClient(cfg *config.Config) (*orchestrator.Client, error) {
	ca := ""
	if cfg.Orchestrator.CABundlePath != nil {
		ca = *cfg.Orchestrator.CABundlePath
	}
	return orchestrator.New(orchestrator.Options{BaseURL: cfg.Orchestrator.BaseURL, APIKey: cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure, CABundlePath: ca, Logger: slog.New(slog.DiscardHandler)})
}

func defaultHostUpdateDeps() hostUpdateDeps {
	logger := slog.New(slog.DiscardHandler)
	return hostUpdateDeps{
		reconcile: agentbus.ReconcileConfiguredHostDaemon,
		policy: func(ctx context.Context, w io.Writer) error {
			// Worker: only on a persistent host for this user, otherwise retired.
			// Schedule: nightly on auto-update hosts, otherwise removed.
			return errors.Join(agentbus.EnsureService(w, w), hostcron.Install(ctx, nil))
		},
		assignments: func(ctx context.Context, seed *config.Config, output io.Writer) ([]*config.Config, error) {
			exe, err := os.Executable()
			if err != nil {
				return nil, err
			}
			return hostcron.RefreshForUpdate(ctx, seed, exe, output)
		},
		resolve: configPathFor,
		load: func(ctx context.Context, path, engine string) (*config.Config, error) {
			key, err := signing.PublicKey()
			if err != nil {
				return nil, err
			}
			cfg, err := config.LoadForEngine(path, key, false, engine)
			var expired *config.ExpiredError
			if errors.As(err, &expired) && expired.Config != nil {
				// An expired but verified config may seed the shared refresh,
				// including when its own engine has since been unassigned.
				cfg, err = expired.Config, nil
			}
			if err != nil {
				return nil, err
			}
			if err := guardUpdateHost(cfg); err != nil {
				return nil, err
			}
			return cfg, nil
		},
		check: func(ctx context.Context, cfg *config.Config, version string) (*orchestrator.CronCheckResponse, error) {
			client, err := updateClient(cfg)
			if err != nil {
				return nil, err
			}
			return client.CronCheck(ctx, orchestrator.CronCheckRequest{Engine: cfg.Engine, ClientVersion: version, WrapperVersion: Version, Probe: true})
		},
		version: func(ctx context.Context, engine string) string {
			probe, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			switch engine {
			case "codex":
				return knownNativeVersion(codex.Version(probe))
			case "claude":
				return knownNativeVersion(claude.Version(probe))
			default:
				path, err := grok.FindCLI()
				if err != nil {
					return ""
				}
				version, _ := grok.ProbeVersion(probe, path)
				return version
			}
		},
		protect: func(ctx context.Context, cfg *config.Config) error {
			switch cfg.Engine {
			case "codex":
				return codexapp.ProtectUpdateAuth(ctx, cfg, logger)
			case "claude":
				return claudeapp.ProtectUpdateAuth(ctx, cfg, logger)
			default:
				return nil // Grok hosts hold access-only projections.
			}
		},
		installWrapper: func(ctx context.Context, cfg *config.Config, artifact *orchestrator.CronWrapperBlock) (string, error) {
			base, err := url.Parse(cfg.Orchestrator.BaseURL)
			if err != nil {
				return "", err
			}
			location, err := url.Parse(artifact.URL)
			if err != nil {
				return "", err
			}
			if artifact.URL == "" || artifact.SHA256 == "" {
				return "", errors.New("wrapper metadata incomplete")
			}
			return coreupdate.Install(ctx, cfg, base.ResolveReference(location).String(), artifact.SHA256, artifact.TargetVersion, logger)
		},
		reexec: func(exe, target string, args []string) error {
			if os.Getenv(updateHandoffEnv) != "" {
				return errors.New("wrapper update loop detected")
			}
			if err := os.Setenv(updateHandoffEnv, target); err != nil {
				return err
			}
			// The verified executable reports its own version, not the old process's.
			// ReexecAfterUpdateAs retains existing Codex auth-session handoffs.
			return personaUpdate.ReExecAfterUpdateAs(exe, "", append([]string{"update"}, args...))
		},
		install: func(ctx context.Context, engine, target string, exact bool) error {
			switch engine {
			case "codex":
				return codex.EnsureCodexBackground(ctx, target, exact, logger)
			case "claude":
				return claude.EnsureClaudeBackground(ctx, target, exact, logger)
			default:
				current := ""
				if path, err := grok.FindCLI(); err == nil {
					current, _ = grok.ProbeVersion(ctx, path)
				}
				if !exact && current != "" && !codex.SemverGT(target, current) {
					return nil
				}
				_, err := grok.Install(ctx, target)
				return err
			}
		},
		sync: func(ctx context.Context, cfg *config.Config) error {
			switch cfg.Engine {
			case "codex":
				_, err := codexlifecycle.Run(ctx, codexlifecycle.Options{Config: cfg, SyncOnly: true, SkipBoot: true, Headless: true, Logger: logger, WrapperVersion: Version})
				return err
			case "claude":
				_, err := claudelifecycle.Run(ctx, claudelifecycle.Options{Config: cfg, SyncOnly: true, SkipBoot: true, Headless: true, Logger: logger, WrapperVersion: Version})
				return err
			default:
				return grokapp.SyncForUpdate(ctx, cfg, logger)
			}
		},
		report: func(ctx context.Context, cfg *config.Config, version string) error {
			client, err := updateClient(cfg)
			if err != nil {
				return err
			}
			var reportErr error
			for attempt := 0; attempt < 2; attempt++ {
				reportErr = client.CronReport(ctx, orchestrator.CronReportRequest{Engine: cfg.Engine, ClientVersion: version, WrapperVersion: Version})
				if reportErr == nil || ctx.Err() != nil {
					return reportErr
				}
			}
			return reportErr
		},
	}
}

func guardUpdateHost(cfg *config.Config) error {
	switch cfg.Engine {
	case "codex":
		return codex.GuardFQDN(cfg)
	case "claude":
		return claude.GuardFQDN(cfg)
	default:
		return grok.GuardFQDN(cfg)
	}
}

func knownNativeVersion(version string) string {
	version = strings.TrimSpace(version)
	if version == "unknown" {
		return ""
	}
	return version
}
