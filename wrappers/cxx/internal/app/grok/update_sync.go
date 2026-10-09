package grok

import (
	"context"
	"errors"
	"log/slog"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

// SyncForUpdate keeps host maintenance on Grok's own managed-content path.
func SyncForUpdate(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	client, err := newClient(cfg)
	if err != nil {
		return err
	}
	client.Logger = logger
	summary, err := syncMeasuredManaged(ctx, cfg, client)
	if err == nil && summary.Skills.Failed {
		return errors.New("Grok skills sync incomplete")
	}
	return err
}
