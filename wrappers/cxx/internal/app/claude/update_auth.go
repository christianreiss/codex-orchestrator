package claudeapp

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/ui"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/update"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/lifecycle"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
)

func protectUpdateAuth(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	opts := orchestrator.Options{BaseURL: cfg.Orchestrator.BaseURL, APIKey: cfg.Orchestrator.APIKey, AllowInsecure: cfg.Orchestrator.AllowInsecure, Logger: logger}
	if cfg.Orchestrator.CABundlePath != nil {
		opts.CABundlePath = *cfg.Orchestrator.CABundlePath
	}
	client, err := orchestrator.New(opts)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return lifecycle.UploadPendingAuthBeforeUpdate(ctx, client, logger)
}

// Wrapper maintenance never acquires new native credentials. Its failure path
// must not create a purge request or delete the pre-existing pending login.
func cmdWrapperUpdate(ctx context.Context, cfg *config.Config, f flags, logger *slog.Logger, stdout, stderr io.Writer) (code int) {
	leaseCtx, leaseCancel := context.WithTimeout(ctx, 5*time.Second)
	commandSession, err := claude.StartAuthSessionContext(leaseCtx, false)
	leaseCancel()
	if err != nil {
		ui.Say(stderr, "clx", ui.ToneFail, "update", "start maintenance session: "+fmt.Sprint(err))
		return 1
	}
	defer func() {
		if err := commandSession.Close(); err != nil {
			ui.Say(stderr, "clx", ui.ToneFail, "update", "close maintenance session: "+fmt.Sprint(err))
			code = 1
		}
	}()
	theme := ""
	if cfg.EngineOptions.AdminThemeHint != nil {
		theme = *cfg.EngineOptions.AdminThemeHint
	}
	errCaps := commandCaps(ui.DetectCapsFor(stderr, theme), f.minimal)
	if err := protectUpdateAuth(ctx, cfg, logger); err != nil {
		fmt.Fprintln(stderr, ui.UpdateFailure(errCaps, "clx", "wrapper", Version, err))
		return 1
	}
	artifact, err := resolveWrapperUpdateArtifact(ctx, cfg, Version, nil)
	if err != nil {
		fmt.Fprintln(stderr, ui.UpdateFailure(errCaps, "clx", "wrapper", Version, err))
		return 1
	}
	fmt.Fprintln(stderr, ui.UpdateProgress(errCaps, "clx", "wrapper", Version, artifact.Version))
	exe, err := update.SelfUpdateFrom(ctx, cfg, artifact.URL, artifact.SHA256, artifact.Version, logger)
	if err != nil {
		fmt.Fprintln(stderr, ui.UpdateFailure(errCaps, "clx", "wrapper", artifact.Version, err))
		return 1
	}
	if err := protectUpdateAuth(ctx, cfg, logger); err != nil {
		fmt.Fprintln(stderr, ui.UpdateFailure(errCaps, "clx", "wrapper", artifact.Version, err))
		ui.Say(stderr, "clx", ui.ToneWarn, "update", "new wrapper installed; restart deferred until pending credentials can be synchronized")
		return 1
	}
	secure := cfg.Host.Secure
	if artifact.HostSecure != nil {
		secure = *artifact.HostSecure
	}
	if err := commandSession.SetPurgeOnLastExit(!secure); err != nil {
		ui.Say(stderr, "clx", ui.ToneFail, "update", "persist restart auth cleanup: "+fmt.Sprint(err))
		return 1
	}
	// A new binary alone leaves the host stale: CLAUDE.md, settings, MCP
	// servers, collections and skills only ever converge inside a lifecycle.
	// Re-exec into the freshly installed wrapper and sync there, so managed
	// content is written by the new code rather than the one being replaced.
	// syscall.Exec never returns on success, so announce the restart first.
	outCaps := commandCaps(ui.DetectCapsFor(stdout, theme), f.minimal)
	fmt.Fprintln(stdout, ui.UpdateComplete(outCaps, "clx", "wrapper", artifact.Version, true))
	// Settle this successful maintenance lease before syscall.Exec;
	// failure paths above close without purging pending native credentials.
	if err := commandSession.FinalizeForReexec(); err != nil {
		ui.Say(stderr, "clx", ui.ToneFail, "update", "finalize auth session before restart: "+fmt.Sprint(err))
		return 1
	}
	if err := update.ReExecAfterUpdateAs(exe, postUpdateSyncEngine(), postUpdateSyncArgv(f)); err != nil {
		fmt.Fprintln(stderr, ui.UpdateFailure(errCaps, "clx", "wrapper", artifact.Version, err))
		ui.Say(stderr, "clx", ui.ToneWarn, "update", "the new wrapper is installed but managed content was not synced; run `clx sync`")
		return 1
	}
	return 0
}
