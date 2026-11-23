// Package launchupdate brings an inactive host's wrapper up to date before
// entering the managed launch protocol.
package launchupdate

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/buildinfo"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/maintenance"
	claudeorchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
)

const (
	staleAfter     = 24 * time.Hour
	probeTimeout   = 8 * time.Second
	installTimeout = 2 * time.Minute
	restartedEnv   = "CXX_LAUNCH_UPDATED"
)

type launchKey struct{}

type launchAttempt struct {
	cacheFailure bool
}

// Prepare checks an inactive host before admission, or checks after a current
// launch fails on a known communicator error. Defer the returned callback
// before taking auth and content leases so they close before any re-exec.
func Prepare(ctx context.Context, cfg *config.Config, guard func(*config.Config) error, stderr io.Writer) (context.Context, func()) {
	if os.Getenv(restartedEnv) == strconv.Itoa(os.Getpid()) {
		waitForOldOwner(ctx, cfg.Orchestrator.BaseURL)
		return ctx, func() {}
	}
	if !buildinfo.Release() || !cfg.Wrapper.AutoUpdate || cfg.EngineSuspended(cfg.Engine) || guard(cfg) != nil {
		return ctx, func() {}
	}
	if due(cfg, buildinfo.Version, time.Now()) {
		attemptRepair(ctx, cfg, stderr)
		return ctx, func() {}
	}
	attempt := &launchAttempt{}
	return context.WithValue(ctx, launchKey{}, attempt), func() {
		if attempt.cacheFailure {
			attemptRepair(ctx, cfg, stderr)
		}
	}
}

// CacheFailure records a failed pre-launch admission. Neither the failed
// request nor a started native command is replayed by the update transport.
func CacheFailure(ctx context.Context, err error) error {
	if attempt, ok := ctx.Value(launchKey{}).(*launchAttempt); ok && recoverable(err) {
		attempt.cacheFailure = true
	}
	return fmt.Errorf("fresh cache confirmation failed: %w", err)
}

func recoverable(err error) bool {
	var code string
	if v, ok := errors.AsType[*orchestrator.HTTPError](err); ok {
		code = v.Code
	}
	if v, ok := errors.AsType[*claudeorchestrator.HTTPError](err); ok {
		code = v.Code
	}
	switch code {
	case "communicator_outcome_unknown", "communicator_unavailable":
		return true
	default:
		return false
	}
}

func attemptRepair(ctx context.Context, cfg *config.Config, stderr io.Writer) {
	installed, version, err := repair(ctx, cfg, buildinfo.Version, stderr)
	if installed != "" {
		fmt.Fprintf(stderr, "cxx %s → %s installed. Continuing startup.\n", buildinfo.Version, version)
		argv := launchArgv(installed, cfg.Engine, os.Args)
		env := slices.DeleteFunc(os.Environ(), func(kv string) bool { return strings.HasPrefix(kv, restartedEnv+"=") })
		err = syscall.Exec(installed, argv, append(env, restartedEnv+"="+strconv.Itoa(os.Getpid())))
	}
	if err != nil && !errors.Is(err, maintenance.ErrBusy) && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(stderr, "cxx startup update:", err)
	}
}

// The on-demand owner checks for binary replacement every five seconds and
// retires when quiet. Give it one cycle before this process enters admission.
// A busy or resident owner follows the existing compatibility and drain paths.
func waitForOldOwner(ctx context.Context, baseURL string) {
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	for {
		owner, ok := communicator.OwnerStatus(ctx, baseURL)
		if !ok || owner.Mode != "on_demand" || !communicator.OlderThan(owner.Version, buildinfo.Version) ||
			owner.Clients == nil || *owner.Clients != 0 || (owner.ManagedSessions != nil && *owner.ManagedSessions != 0) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func due(cfg *config.Config, running string, now time.Time) bool {
	cmp, err := update.CompareVersions(cfg.Wrapper.Version, running)
	issuedAt, dateErr := time.Parse(time.RFC3339, cfg.IssuedAt)
	return err == nil && cmp > 0 || dateErr != nil || now.Sub(issuedAt) >= staleAfter
}

func repair(ctx context.Context, seed *config.Config, running string, stderr io.Writer) (string, string, error) {
	lock, err := maintenance.LockForLaunch()
	if err != nil {
		return "", "", err
	}
	defer lock.Release()

	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	fetched, err := fleetconfig.FetchDirect(probeCtx, seed, seed.Engine)
	if err != nil {
		return "", "", err
	}
	cfg := fetched.Config
	if !cfg.Wrapper.AutoUpdate || cfg.EngineSuspended(cfg.Engine) {
		return "", "", fleetconfig.PersistTo(probeCtx, seed.SourcePath(), fetched)
	}
	check, err := checkRelease(probeCtx, cfg, running)
	if err != nil {
		return "", "", err
	}
	target, err := verifyTarget(cfg, check, running)
	if err != nil {
		return "", "", err
	}
	if target == nil {
		return "", "", fleetconfig.PersistTo(probeCtx, seed.SourcePath(), fetched)
	}

	base, err := url.Parse(cfg.Orchestrator.BaseURL)
	if err != nil {
		return "", "", err
	}
	// The signed URL identifies the artifact. There is no need to trust a URL
	// from the unsigned probe response.
	location, err := url.Parse(cfg.Wrapper.BinaryURL)
	if err != nil {
		return "", "", err
	}
	if err := fleetconfig.PersistTo(probeCtx, seed.SourcePath(), fetched); err != nil {
		return "", "", err
	}
	installCtx, stop := context.WithTimeout(ctx, installTimeout)
	defer stop()
	fmt.Fprintf(stderr, "Updating cxx from %s to %s before startup…\n", running, target.TargetVersion)
	exe, err := update.Install(installCtx, cfg, base.ResolveReference(location).String(), cfg.Wrapper.BinarySHA256,
		target.TargetVersion, slog.New(slog.DiscardHandler))
	return exe, target.TargetVersion, err
}

func checkRelease(ctx context.Context, cfg *config.Config, running string) (*orchestrator.CronCheckResponse, error) {
	httpClient, err := update.DirectHTTPClient(cfg)
	if err != nil {
		return nil, err
	}
	defer httpClient.CloseIdleConnections()
	client := orchestrator.Client{BaseURL: cfg.Orchestrator.BaseURL, APIKey: cfg.Orchestrator.APIKey,
		HTTP: httpClient, UserAgent: "cxx-startup-update", Logger: slog.New(slog.DiscardHandler)}
	return client.CronCheck(ctx, orchestrator.CronCheckRequest{Engine: cfg.Engine, WrapperVersion: running, Probe: true})
}

func verifyTarget(cfg *config.Config, check *orchestrator.CronCheckResponse, running string) (*orchestrator.CronWrapperBlock, error) {
	w := check.Wrapper
	switch check.Action {
	case "disable":
		return nil, nil
	case "no_update", "update":
	default:
		return nil, errors.New("unexpected action in wrapper update probe")
	}
	if w == nil || w.Action == "no_update" {
		return nil, nil
	}
	if w.Action != "update" {
		return nil, errors.New("unexpected wrapper action in update probe")
	}
	cmp, err := update.CompareVersions(w.TargetVersion, running)
	if err != nil {
		return nil, err
	}
	if cmp <= 0 {
		return nil, nil
	}
	signed, err := update.CompareVersions(cfg.Wrapper.Version, w.TargetVersion)
	if err != nil || signed != 0 || strings.TrimSpace(w.SHA256) == "" ||
		!strings.EqualFold(strings.TrimSpace(cfg.Wrapper.BinarySHA256), strings.TrimSpace(w.SHA256)) ||
		strings.TrimSpace(cfg.Wrapper.BinaryURL) == "" {
		return nil, errors.New("offered wrapper release does not match the signed configuration")
	}
	return w, nil
}

func launchArgv(installed, engine string, original []string) []string {
	argv := []string{installed}
	switch filepath.Base(original[0]) {
	case "cdx", "clx", "cgx", "ckx":
		argv = append(argv, engine)
	default:
		if len(original) == 1 {
			argv = append(argv, engine) // cxx launchpad already selected it.
		}
	}
	return append(argv, original[1:]...)
}
