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

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
)

// ReExecAfterUpdate replaces the current process with a fresh exec of `exe`
// using the snapshotted argv (captured at process start). Sets
// CLAUDE_WRAPPER_RESTARTED=1 and increments CLAUDE_WRAPPER_RESTART_DEPTH so
// main.go can detect runaway restart loops.
func ReExecAfterUpdate(exe string, argv []string) error {
	if exe == "" {
		return errors.New("ReExecAfterUpdate: empty exe path")
	}
	full := append([]string{exe}, argv...)
	depth, _ := strconv.Atoi(os.Getenv("CLAUDE_WRAPPER_RESTART_DEPTH"))
	env := os.Environ()
	env = setEnvKV(env, "CLAUDE_WRAPPER_RESTARTED", "1")
	env = setEnvKV(env, "CLAUDE_WRAPPER_RESTART_DEPTH", strconv.Itoa(depth+1))
	return syscall.Exec(exe, full, env)
}

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

func SelfUpdate(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return err
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
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("download: HTTP %d", resp.StatusCode)
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
	if err := os.Rename(tmp, exe); err != nil {
		_ = os.Remove(tmp)
		return errors.New("atomic swap failed: " + err.Error())
	}
	logger.Info("self-update complete", "version", cfg.Wrapper.Version, "path", exe)
	return nil
}

// SnapshottedArgv holds the argv as captured at process start (excluding the
// program name in argv[0]). main.go sets this for parity with cdx; cron uses
// ReExecAfterUpdate with a sanitized argv when it needs a second pass.
var SnapshottedArgv []string
