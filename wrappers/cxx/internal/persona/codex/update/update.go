package update

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"syscall"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/layout"
	coreupdate "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/update"
)

func ReExecAfterUpdate(exe string, argv []string) (err error) {
	if exe == "" {
		return errors.New("ReExecAfterUpdate: empty exe path")
	}
	full := layout.ReexecArgv(exe, layout.EngineCodex, argv)
	depth, _ := strconv.Atoi(os.Getenv("CODEX_WRAPPER_RESTART_DEPTH"))
	env := setEnvKV(os.Environ(), "CODEX_WRAPPER_RESTARTED", "1")
	env = setEnvKV(env, "CODEX_WRAPPER_RESTART_DEPTH", strconv.Itoa(depth+1))
	env, cancelHandoff, err := codex.PrepareAuthSessionReexec(env)
	if err != nil {
		return fmt.Errorf("prepare auth sessions for wrapper re-exec: %w", err)
	}
	defer func() { err = errors.Join(err, cancelHandoff()) }()
	return syscall.Exec(exe, full, env)
}

func setEnvKV(env []string, key, val string) []string {
	prefix := key + "="
	for i, item := range env {
		if len(item) >= len(prefix) && item[:len(prefix)] == prefix || item == key {
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

func SelfUpdateFrom(ctx context.Context, cfg *config.Config, binaryURL, binarySHA256, targetVersion string, logger *slog.Logger) (string, error) {
	return coreupdate.Install(ctx, cfg, binaryURL, binarySHA256, targetVersion, logger)
}

func installVerifiedBinary(source, dest string) error {
	return coreupdate.InstallVerifiedBinary(source, dest)
}

var SnapshottedArgv []string
