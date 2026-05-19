// Package uninstall removes the wrapper, its config, and ~/.codex state.
// Calls DELETE /auth?force=1 server-side first so the host is unregistered.
package uninstall

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/orchestrator"
)

// Run performs an uninstall.
func Run(ctx context.Context, cfg *config.Config, stdout, stderr io.Writer) error {
	// Best-effort server-side delete.
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err == nil {
		req, _ := http.NewRequestWithContext(ctx, http.MethodDelete, cfg.Orchestrator.BaseURL+"/auth?force=1", nil)
		resp, derr := client.Do(ctx, req, 0)
		if derr != nil {
			fmt.Fprintln(stderr, "uninstall: server-side delete failed (best-effort):", derr)
		} else {
			resp.Body.Close()
			fmt.Fprintf(stdout, "uninstall: server-side delete -> HTTP %d\n", resp.StatusCode)
		}
	}

	// Remove local state.
	home, _ := os.UserHomeDir()
	targets := []string{
		filepath.Join(home, ".codex", "auth.json"),
		filepath.Join(home, ".codex", "AGENTS.md"),
		filepath.Join(home, ".codex", "config.toml"),
		filepath.Join(home, ".config", "codex-orchestrator", "cdx.json"),
		filepath.Join(home, ".config", "codex-orchestrator", "cdx.json.sig"),
	}
	for _, p := range targets {
		err := os.Remove(p)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(stderr, "uninstall: remove", p, ":", err)
			continue
		}
		fmt.Fprintln(stdout, "uninstall: removed", p)
	}

	// Best-effort: remove cron entry. Importing cron here would create a
	// circular dep at the cmd layer if cron grows imports — keep it inline.
	return nil
}
