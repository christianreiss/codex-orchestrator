package codexapp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/authnotice"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/lifecycle"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

// cmdAuthSync is an internal worker adapter. No live native child means no
// request or new auth lease; an idle insecure purge must remain final.
func cmdAuthSync(ctx context.Context, cfg *config.Config, stdout, stderr io.Writer) (exitCode int) {
	active, err := codex.HasActiveAuthChild()
	if err != nil {
		fmt.Fprintln(stderr, "auth-sync: active session probe:", err)
		return 1
	}
	if !active {
		return 0
	}
	// The existing session owns its purge policy; only a live auth response
	// may revise it, not a possibly stale baked secure/insecure flag.
	session, err := codex.StartAuthSession(false)
	if err != nil {
		fmt.Fprintln(stderr, "auth-sync:", err)
		return 1
	}
	defer func() {
		if _, _, err := codex.FinishAuthSession(session); err != nil {
			fmt.Fprintln(stderr, "auth-sync: session cleanup:", err)
			exitCode = 1
		}
	}()
	active, err = codex.HasActiveAuthChild()
	if err != nil {
		fmt.Fprintln(stderr, "auth-sync: active session probe:", err)
		return 1
	}
	if !active {
		return 0
	}
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL: cfg.Orchestrator.BaseURL, APIKey: cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
		CABundlePath:  configuredCABundle(cfg),
		Logger:        slog.New(slog.DiscardHandler),
	})
	if err != nil {
		fmt.Fprintln(stderr, "auth-sync:", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result, err := lifecycle.SyncSessionAuth(ctx, client, slog.New(slog.DiscardHandler))
	if err != nil {
		fmt.Fprintln(stderr, "auth-sync:", err)
		return 1
	}
	if result.Adopted {
		_ = authnotice.Publish("codex", result.Generation.Digest)
	}
	if err := json.NewEncoder(stdout).Encode(result); err != nil {
		fmt.Fprintln(stderr, "auth-sync: result:", err)
		return 1
	}
	return 0
}

func configuredCABundle(cfg *config.Config) string {
	if cfg != nil && cfg.Orchestrator.CABundlePath != nil {
		return *cfg.Orchestrator.CABundlePath
	}
	return ""
}
