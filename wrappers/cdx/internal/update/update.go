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
	"strconv"
	"syscall"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
)

// ReExecAfterUpdate replaces the current process with a fresh exec of `exe`
// using the supplied argv (which the caller should have snapshotted at
// process start, before any flag parsing mutated it). The new process
// inherits the current environment plus CODEX_WRAPPER_RESTARTED=1 and an
// incremented CODEX_WRAPPER_RESTART_DEPTH counter that main.go enforces a
// ceiling on.
//
// Cron callers reuse this helper after their own self-update so the restart
// happens via the same code path as the interactive --update flow.
func ReExecAfterUpdate(exe string, argv []string) error {
	if exe == "" {
		return errors.New("ReExecAfterUpdate: empty exe path")
	}
	full := append([]string{exe}, argv...)

	depth, _ := strconv.Atoi(os.Getenv("CODEX_WRAPPER_RESTART_DEPTH"))
	env := os.Environ()
	env = setEnvKV(env, "CODEX_WRAPPER_RESTARTED", "1")
	env = setEnvKV(env, "CODEX_WRAPPER_RESTART_DEPTH", strconv.Itoa(depth+1))

	return syscall.Exec(exe, full, env)
}

// setEnvKV replaces (or appends) a single KEY=VAL entry in an environ slice.
func setEnvKV(env []string, key, val string) []string {
	prefix := key + "="
	for i, e := range env {
		if len(e) > len(prefix) && e[:len(prefix)] == prefix {
			env[i] = prefix + val
			return env
		}
		if e == key {
			env[i] = prefix + val
			return env
		}
	}
	return append(env, prefix+val)
}

// SelfUpdate downloads cfg.Wrapper.BinaryURL, verifies the SHA256 against
// cfg.Wrapper.BinarySHA256, then atomically renames it over the running
// executable. The explicit `cdx --update` command exits after the swap; cron
// callers use ReExecAfterUpdate with a sanitized argv when they need a second
// pass on the freshly installed binary.
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

// SnapshottedArgv holds the argv as captured at process start (excluding the
// program name in argv[0]). main.go sets this for diagnostics and parity with
// the previous update flow; cron uses ReExecAfterUpdate with a sanitized argv.
var SnapshottedArgv []string
