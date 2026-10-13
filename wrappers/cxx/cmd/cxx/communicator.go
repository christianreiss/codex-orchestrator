package main

import (
	"context"
	"errors"
	"strings"

	grokapp "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/app/grok"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/communicator"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/fleetconfig"
	claudelife "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/claude/lifecycle"
	codexlife "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/lifecycle"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/signing"
)

func communicatorWork(ctx context.Context, cfg *config.Config, req communicator.SyncRequest) communicator.SyncResult {
	// A push refreshes the signed host policy as well as managed content. Fetch
	// uses the existing communicator transport; persistence uses the established
	// config lock. No installer, cron, account selection or native startup runs.
	var policy communicator.ResourceResult
	if req.Operation == "content" {
		fetched, err := fleetconfig.Fetch(ctx, cfg, cfg.Engine)
		if err == nil && strings.TrimRight(fetched.Config.Orchestrator.BaseURL, "/") != strings.TrimRight(cfg.Orchestrator.BaseURL, "/") {
			err = errors.New("signed config changed communicator server")
		}
		if err == nil {
			err = fleetconfig.PersistTo(ctx, req.Job.Config, fetched)
		}
		if err == nil {
			key, keyErr := signing.PublicKey()
			err = keyErr
			if err == nil {
				cfg, err = config.LoadForEngine(req.Job.Config, key, false, req.Job.Engine)
			}
		}
		policy = communicator.Resource(true, err == nil, err)
		if cfg == nil {
			return communicator.SyncResult{Error: &communicator.SyncError{Message: "refreshed signed config could not be loaded"}}
		}
	}
	var out communicator.SyncResult
	switch cfg.Engine {
	case "codex":
		out = codexlife.CommunicatorWork(ctx, cfg, req)
	case "claude":
		out = claudelife.CommunicatorWork(ctx, cfg, req)
	case "grok":
		out = grokapp.CommunicatorWork(ctx, cfg, req)
	default:
		return communicator.SyncResult{Error: &communicator.SyncError{Message: "invalid sync engine"}}
	}
	if policy.Checked {
		if out.Resources == nil {
			out.Resources = map[string]communicator.ResourceResult{}
		}
		out.Resources["wrapper_config"] = policy
	}
	return out
}
