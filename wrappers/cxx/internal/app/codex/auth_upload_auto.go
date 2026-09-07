package codexapp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/lifecycle"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
)

// Automatic maintenance creates no new purge obligation until the native
// candidate is confirmed. Existing outstanding cleanup remains authoritative.
func cmdAuthUploadAuto(ctx context.Context, cfg *config.Config, stdout, stderr io.Writer) (exitCode int) {
	session, err := codex.StartAuthSession(false)
	if err != nil {
		fmt.Fprintln(stderr, "auth-upload-auto:", err)
		return 1
	}
	defer func() {
		if _, _, err := codex.FinishAuthSession(session); err != nil {
			fmt.Fprintln(stderr, "auth-upload-auto: session cleanup:", err)
			exitCode = 1
		}
	}()
	logger := slog.New(slog.DiscardHandler)
	client, err := orchestrator.New(orchestrator.Options{BaseURL: cfg.Orchestrator.BaseURL, APIKey: cfg.Orchestrator.APIKey, AllowInsecure: cfg.Orchestrator.AllowInsecure, CABundlePath: configuredCABundle(cfg), Logger: logger})
	if err != nil {
		fmt.Fprintln(stderr, "auth-upload-auto:", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result, err := lifecycle.UploadAutomaticAuth(ctx, client, logger)
	if err != nil {
		fmt.Fprintln(stderr, "auth-upload-auto:", err)
		return 1
	}
	if err := json.NewEncoder(stdout).Encode(result); err != nil {
		fmt.Fprintln(stderr, "auth-upload-auto: result:", err)
		return 1
	}
	return 0
}
