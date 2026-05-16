package codex

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

// Doctor runs a series of diagnostic checks and writes a human-readable report
// to w. Returns the first error encountered (or nil if everything is green).
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

	fmt.Fprintln(w, "cdx doctor")
	record(check("config schema_version", func() error {
		if cfg.SchemaVersion != config.SchemaVersion {
			return fmt.Errorf("got %d", cfg.SchemaVersion)
		}
		return nil
	}))
	record(check("codex CLI present", func() error {
		_, err := FindCLI()
		return err
	}))
	record(check("auth.json exists", func() error {
		p, err := AuthPath()
		if err != nil {
			return err
		}
		if _, err := os.Stat(p); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return errors.New("missing — run `cdx run` once to sync, or seed via the orchestrator")
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
	record(check("auth digest matches server", func() error {
		client, err := orchestrator.New(orchestrator.Options{
			BaseURL:       cfg.Orchestrator.BaseURL,
			APIKey:        cfg.Orchestrator.APIKey,
			AllowInsecure: cfg.Orchestrator.AllowInsecure,
		})
		if err != nil {
			return err
		}
		digest, err := LocalDigest()
		if err != nil {
			return err
		}
		resp, err := client.AuthRetrieve(ctx, digest)
		if err != nil {
			return err
		}
		switch resp.Status {
		case "current", "ok":
			return nil
		case "missing":
			return errors.New("server reports missing auth — seed it via the orchestrator")
		case "outdated":
			return errors.New("server has a newer auth.json — `cdx run` once to refresh")
		default:
			return fmt.Errorf("unexpected status %q", resp.Status)
		}
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
