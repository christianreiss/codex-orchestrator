// Package uninstall removes the clx wrapper, its config, and ~/.claude state.
package uninstall

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/orchestrator"
)

func Run(ctx context.Context, cfg *config.Config, stdout, stderr io.Writer) error {
	client, err := orchestrator.New(orchestrator.Options{
		BaseURL:       cfg.Orchestrator.BaseURL,
		APIKey:        cfg.Orchestrator.APIKey,
		AllowInsecure: cfg.Orchestrator.AllowInsecure,
	})
	if err == nil {
		req, _ := http.NewRequestWithContext(ctx, http.MethodDelete, cfg.Orchestrator.BaseURL+"/auth?force=1&engine=claude", nil)
		resp, derr := client.Do(ctx, req, 0)
		if derr != nil {
			fmt.Fprintln(stderr, "uninstall: server-side delete failed (best-effort):", derr)
		} else {
			resp.Body.Close()
			fmt.Fprintf(stdout, "uninstall: server-side delete -> HTTP %d\n", resp.StatusCode)
		}
	}

	home, _ := os.UserHomeDir()
	targets := []string{
		filepath.Join(home, ".claude", ".credentials.json"),
		filepath.Join(home, ".claude", "settings.json"),
		filepath.Join(home, ".claude", "CLAUDE.md"),
		filepath.Join(home, ".config", "codex-orchestrator", "clx.json"),
		filepath.Join(home, ".config", "codex-orchestrator", "clx.json.sig"),
	}
	for _, p := range targets {
		err := os.Remove(p)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(stderr, "uninstall: remove", p, ":", err)
			continue
		}
		fmt.Fprintln(stdout, "uninstall: removed", p)
	}
	return nil
}
