package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentbus"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/agentquiet"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
	coreupdate "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
	"golang.org/x/sys/unix"
)

func init() {
	communicator.RegisterUpdater(func(ctx context.Context, env communicator.UpdaterEnv) {
		newCommUpdater(env).run(ctx)
	})
}

// updateTarget is an update the server offers AND the signed config names.
type updateTarget struct {
	Version, SHA256, URL string
}

// commUpdater is the communicator's push-triggered updater. A trigger only
// starts a check: the target must be offered by the host's /cron/check (which
// applies auto-update, fleet locks and rollout policy) and match the signed
// configuration's wrapper version and digest. It prefetches immediately and
// applies, through the ordinary `cxx update`, only once no agent is running.
type commUpdater struct {
	env       communicator.UpdaterEnv
	running   string
	backstop  time.Duration
	quietPoll time.Duration
	now       func() time.Time

	load     func(path string) (*config.Config, error)
	fetch    func(ctx context.Context, seed *config.Config) (*config.Config, error)
	check    func(ctx context.Context, cfg *config.Config) (*orchestrator.CronCheckResponse, error)
	prefetch func(ctx context.Context, cfg *config.Config, t updateTarget) error
	agents   func() int
	target   func() (string, error)
	writable func(path string) bool
	apply    func(ctx context.Context, exe string) error
	handoff  func(t updateTarget, exe string) error
}

func newCommUpdater(env communicator.UpdaterEnv) *commUpdater {
	return &commUpdater{
		env: env, running: env.Version(), backstop: 6 * time.Hour, quietPoll: 5 * time.Second, now: time.Now,
		load: func(path string) (*config.Config, error) {
			key, err := signing.PublicKey()
			if err != nil {
				return nil, err
			}
			return config.Load(path, key, false)
		},
		fetch: func(ctx context.Context, seed *config.Config) (*config.Config, error) {
			fetched, err := fleetconfig.Fetch(ctx, seed, seed.Engine)
			if err != nil {
				return nil, err
			}
			return fetched.Config, nil
		},
		check: func(ctx context.Context, cfg *config.Config) (*orchestrator.CronCheckResponse, error) {
			client, err := updateClient(cfg)
			if err != nil {
				return nil, err
			}
			return client.CronCheck(ctx, orchestrator.CronCheckRequest{Engine: cfg.Engine, WrapperVersion: env.Version(), Probe: true})
		},
		prefetch: func(ctx context.Context, cfg *config.Config, t updateTarget) error {
			_, err := coreupdate.Prefetch(ctx, cfg, t.URL, t.SHA256, t.Version)
			return err
		},
		agents:   func() int { return env.Busy() + len(agentquiet.Busy()) },
		target:   func() (string, error) { return userExecutable(env.Resident()) },
		writable: func(path string) bool { return unix.Access(filepath.Dir(path), unix.W_OK) == nil },
		apply: func(ctx context.Context, exe string) error {
			run, cancel := context.WithTimeout(ctx, 12*time.Minute)
			defer cancel()
			cmd := exec.CommandContext(run, exe, "update", "--minimal")
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			return cmd.Run()
		},
		handoff: requestResidentHandoff,
	}
}

func (u *commUpdater) report(state string, t *updateTarget, agents int, reason string) {
	st := communicator.UpdateStatus{State: state, Running: u.running, Agents: agents, Reason: reason, At: u.now().UTC().Format(time.RFC3339)}
	if t != nil {
		st.Target = t.Version
	}
	u.env.Report(st)
}

// detect returns the update to stage, or nil with the reason there is none.
func (u *commUpdater) detect(ctx context.Context) (*updateTarget, string) {
	seed, err := u.load(u.env.ConfigPath())
	var expired *config.ExpiredError
	if errors.As(err, &expired) && expired.Config != nil {
		seed, err = expired.Config, nil
	}
	if err != nil {
		return nil, "config_unavailable"
	}
	cfg, err := u.fetch(ctx, seed)
	if err != nil || cfg == nil {
		return nil, "config_refresh_failed"
	}
	if cfg.Orchestrator.CommunicatorUpdateProtocol != communicator.UpdateProtocol {
		return nil, "capability_disabled"
	}
	check, err := u.check(ctx, cfg)
	if err != nil || check == nil {
		return nil, "check_failed"
	}
	if check.Action == "disable" {
		return nil, "updates_disabled"
	}
	w := check.Wrapper
	if w == nil || w.Action != "update" {
		return nil, ""
	}
	cmp, err := coreupdate.CompareVersions(w.TargetVersion, u.running)
	if err != nil {
		return nil, "invalid_target"
	}
	if cmp <= 0 {
		if cmp < 0 {
			return nil, "downgrade_refused"
		}
		return nil, ""
	}
	// The signed configuration is the integrity anchor: the offered version and
	// digest must be exactly what it names.
	signed, err := coreupdate.CompareVersions(cfg.Wrapper.Version, w.TargetVersion)
	if err != nil || signed != 0 || !strings.EqualFold(strings.TrimSpace(cfg.Wrapper.BinarySHA256), strings.TrimSpace(w.SHA256)) {
		return nil, "unsigned_target"
	}
	url := w.URL
	if url == "" {
		url = cfg.Wrapper.BinaryURL
	}
	return &updateTarget{Version: w.TargetVersion, SHA256: strings.ToLower(strings.TrimSpace(w.SHA256)), URL: url}, ""
}

func (u *commUpdater) run(ctx context.Context) {
	backstop := time.NewTicker(u.backstop)
	defer backstop.Stop()
	poll := time.NewTicker(u.quietPoll)
	defer poll.Stop()
	var pending *updateTarget
	cfgForPrefetch := func() *config.Config {
		cfg, err := u.load(u.env.ConfigPath())
		var expired *config.ExpiredError
		if errors.As(err, &expired) {
			return expired.Config
		}
		return cfg
	}
	for {
		checkNow := false
		select {
		case <-ctx.Done():
			return
		case <-u.env.Trigger():
			checkNow = true
		case <-backstop.C:
			checkNow = true
		case <-poll.C:
		}
		if checkNow {
			target, reason := u.detect(ctx)
			if target == nil {
				if pending == nil {
					state := "current"
					if reason != "" && reason != "capability_disabled" {
						state = "idle"
					}
					u.report(state, nil, 0, reason)
				}
				// A failed or empty re-check never discards an already
				// verified staged target; the next trigger re-evaluates it.
				if pending == nil || reason == "" || reason == "downgrade_refused" || reason == "updates_disabled" {
					pending = nil
				}
				continue
			}
			if cfg := cfgForPrefetch(); cfg == nil {
				u.report("failed", target, 0, "config_unavailable")
				continue
			} else if err := u.prefetch(ctx, cfg, *target); err != nil {
				u.report("failed", target, 0, "prefetch_failed")
				continue
			}
			pending = target
			u.report("staged", pending, 0, "")
		}
		if pending == nil {
			continue
		}
		if done := u.tryApply(ctx, pending); done {
			pending = nil
		}
	}
}

// tryApply applies a staged target once the host is quiet. It reports and
// returns false while agents run, so the next poll re-evaluates the gate.
func (u *commUpdater) tryApply(ctx context.Context, t *updateTarget) bool {
	if n := u.agents(); n > 0 {
		u.report("waiting_for_quiet", t, n, "")
		return false
	}
	exe, err := u.target()
	if err != nil {
		u.report("failed", t, 0, "executable_unresolved")
		return true
	}
	if !u.writable(exe) {
		// A shared or root-owned install cannot be checked for other users'
		// agents; cron and `cxx update` keep owning it.
		u.report("requires_root", t, 0, "")
		return true
	}
	u.report("applying", t, 0, "")
	if err := u.apply(ctx, exe); err != nil {
		u.report("failed", t, 0, "apply_failed")
		return true
	}
	if u.env.Resident() {
		if err := u.handoff(*t, exe); err != nil {
			u.report("failed", t, 0, "handoff_request_failed")
			return true
		}
		u.report("handoff_requested", t, 0, "")
		return true
	}
	u.report("applied", t, 0, "")
	u.env.Retire()
	return true
}

// userExecutable is the user's canonical cxx, the destination `cxx update`
// installs to. A resident service runs from the root-owned service copy, so it
// locates the user's install on PATH (and the default per-user locations).
func userExecutable(resident bool) (string, error) {
	if !resident {
		exe, err := os.Executable()
		if err != nil {
			return "", err
		}
		return layout.CanonicalExecutable(exe)
	}
	home, _ := os.UserHomeDir()
	path := os.Getenv("PATH")
	for _, dir := range []string{filepath.Join(home, ".local", "bin"), filepath.Join(home, "bin")} {
		path += string(os.PathListSeparator) + dir
	}
	for _, name := range []string{"cxx", "cdx", "clx", "cgx"} {
		for _, dir := range filepath.SplitList(path) {
			candidate := filepath.Join(dir, name)
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
				if strings.HasPrefix(candidate, "/usr/local/lib/cxx-daemon/") {
					continue
				}
				return layout.CanonicalExecutable(candidate)
			}
		}
	}
	return "", fmt.Errorf("no user cxx installation found")
}

// requestResidentHandoff asks the root helper to replace the resident service
// binary with the user install `cxx update` just verified and installed.
func requestResidentHandoff(t updateTarget, exe string) error {
	return agentbus.RequestResidentUpdate(t.Version, t.SHA256, exe)
}
