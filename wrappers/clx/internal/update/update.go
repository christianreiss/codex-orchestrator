package update

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
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
	_, err := SelfUpdateFrom(ctx, cfg, cfg.Wrapper.BinaryURL, cfg.Wrapper.BinarySHA256, cfg.Wrapper.Version, logger)
	return err
}

// SelfUpdateFrom is the same installer as SelfUpdate, but takes the target
// artifact directly. Normal clx startup uses this with the server-reported
// wrapper URL/SHA from the auth response, because the baked local config can
// be older than the running binary.
func SelfUpdateFrom(ctx context.Context, cfg *config.Config, binaryURL, binarySHA256, targetVersion string, logger *slog.Logger) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve self path: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return "", fmt.Errorf("eval self path: %w", err)
	}

	logger.Info("self-update starting", "target_version", targetVersion, "url", binaryURL, "platform", runtime.GOOS+"/"+runtime.GOARCH)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, binaryURL, nil)
	if err != nil {
		return "", err
	}
	if cfg.Orchestrator.APIKey != "" {
		req.Header.Set("X-API-Key", cfg.Orchestrator.APIKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("download binary: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("download binary: HTTP %d", resp.StatusCode)
	}

	tmp, err := os.CreateTemp("", "clx-wrapper-*.new")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o755); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}

	if err := VerifyChecksum(tmpPath, binarySHA256); err != nil {
		return "", err
	}

	if err := installVerifiedBinary(tmpPath, exe); err != nil {
		return "", err
	}
	logger.Info("self-update complete", "version", targetVersion, "path", exe)
	return exe, nil
}

func installVerifiedBinary(src, dest string) error {
	tmp := dest + ".new"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return sudoInstall(src, dest, err)
	}
	srcFile, err := os.Open(src)
	if err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	defer srcFile.Close()
	if _, err := io.Copy(f, srcFile); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, 0o755); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return sudoInstall(src, dest, err)
	}
	return nil
}

func sudoInstall(src, dest string, cause error) error {
	if _, err := exec.LookPath("sudo"); err != nil {
		return errors.New("atomic swap failed: " + cause.Error())
	}
	cmd := exec.Command("sudo", "-n", "install", "-m", "0755", src, dest)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	return fmt.Errorf("atomic swap failed: %v; sudo install failed: %w: %s", cause, err, string(out))
}

// SnapshottedArgv holds the argv as captured at process start (excluding the
// program name in argv[0]). main.go sets this for parity with cdx; cron uses
// ReExecAfterUpdate with a sanitized argv when it needs a second pass.
var SnapshottedArgv []string
