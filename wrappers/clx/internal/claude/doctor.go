package claude

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

func Doctor(ctx context.Context, cfg *config.Config, w io.Writer) error {
	check := func(label string, fn func() error) (err error) {
		fmt.Fprintf(w, "  %-40s ", label+":")
		err = fn()
		if err != nil {
			fmt.Fprintf(w, "FAIL (%v)\n", err)
		} else {
			fmt.Fprintln(w, "ok")
		}
		return err
	}

	var firstErr error
	record := func(err error) {
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}

	fmt.Fprintln(w, "clx doctor")
	record(check("config schema_version", func() error {
		if cfg.SchemaVersion != config.SchemaVersion {
			return fmt.Errorf("got %d", cfg.SchemaVersion)
		}
		return nil
	}))
	record(check("claude CLI present", func() error {
		_, err := FindCLI()
		return err
	}))
	record(check("credentials.json exists", func() error {
		p, err := AuthPath()
		if err != nil {
			return err
		}
		if _, err := os.Stat(p); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return errors.New("missing — run `clx run` once to sync")
			}
			return err
		}
		return nil
	}))
	record(check("orchestrator reachable", func() error {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, cfg.Orchestrator.BaseURL+"/versions", nil)
		client, err := orchestrator.New(orchestrator.Options{
			BaseURL:       cfg.Orchestrator.BaseURL,
			APIKey:        cfg.Orchestrator.APIKey,
			AllowInsecure: cfg.Orchestrator.AllowInsecure,
		})
		if err != nil {
			return err
		}
		resp, err := client.Do(ctx, req, 0)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		return nil
	}))
	record(check("wrapper binary path", func() error {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		_, err = os.Stat(filepath.Clean(exe))
		return err
	}))
	return firstErr
}
