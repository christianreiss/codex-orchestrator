package codexapp

import (
	"context"
	"log/slog"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/lifecycle"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
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
