// Package update fetches a fresh wrapper binary from the orchestrator and
// atomically swaps it in place. The downloaded artifact is verified by SHA256
// before being made live.
package update

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
)

// SelfUpdate downloads cfg.Wrapper.BinaryURL, verifies the SHA256 against
// cfg.Wrapper.BinarySHA256, then atomically renames it over the running
// executable. Caller is responsible for re-exec'ing afterwards.
func SelfUpdate(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve self path: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return fmt.Errorf("eval self path: %w", err)
	}

	logger.Info("self-update starting", "from_version", cfg.Wrapper.Version, "url", cfg.Wrapper.BinaryURL, "platform", runtime.GOOS+"/"+runtime.GOARCH)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.Wrapper.BinaryURL, nil)
	if err != nil {
		return err
	}
	if cfg.Orchestrator.APIKey != "" {
		req.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("download binary: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("download binary: HTTP %d", resp.StatusCode)
	}

	tmp := exe + ".new"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}

	if err := VerifyChecksum(tmp, cfg.Wrapper.BinarySHA256); err != nil {
		_ = os.Remove(tmp)
		return err
	}

	// Atomic-ish: on Linux, rename across the same filesystem is atomic.
	if err := os.Rename(tmp, exe); err != nil {
		_ = os.Remove(tmp)
		return errors.New("atomic swap failed: " + err.Error())
	}
	logger.Info("self-update complete", "version", cfg.Wrapper.Version, "path", exe)
	return nil
}
