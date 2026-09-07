package claudeapp

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/claude"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/lifecycle"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/orchestrator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/ui"
)

func cmdAutomaticAuthUpload(ctx context.Context, cfg *config.Config, logger *slog.Logger, stderr io.Writer) (code int) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	session, err := claude.StartAuthSessionContext(ctx, false)
	if err != nil {
		fmt.Fprintln(stderr, "auth-upload-auto:", err)
		return 1
	}
	defer func() {
		if err := session.Close(); err != nil {
			code = 1
		}
	}()
	client, err := orchestrator.New(orchestrator.Options{BaseURL: cfg.Orchestrator.BaseURL, APIKey: cfg.Orchestrator.APIKey, CABundlePath: caBundlePath(cfg), AllowInsecure: cfg.Orchestrator.AllowInsecure, Logger: logger})
	if err != nil {
		fmt.Fprintln(stderr, "auth-upload-auto:", err)
		return 1
	}
	result, err := lifecycle.UploadIdleAuth(ctx, client)
	if err != nil {
		fmt.Fprintln(stderr, ui.PlainInline("auth-upload-auto: "+err.Error()))
		return 1
	}
	if !result.Uploaded {
		return 0
	}
	secure := cfg.Host.Secure
	if result.HostSecure != nil {
		secure = *result.HostSecure
	}
	if err := session.SetPurgeOnLastExitContext(ctx, !secure); err != nil {
		fmt.Fprintln(stderr, "auth-upload-auto:", err)
		return 1
	}
	if _, err := session.CloseAndPurgeIfLastContext(ctx); err != nil {
		fmt.Fprintln(stderr, "auth-upload-auto: finalize accepted upload:", err)
		return 1
	}
	return 0
}
