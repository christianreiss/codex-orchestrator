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

func ReExecAfterUpdate(exe string, argv []string) error {
	return ReExecAfterUpdateAs(exe, layout.EngineCodex, argv)
}

// ReExecAfterUpdateAs re-execs the freshly installed binary under an explicit
// persona. An empty engine selects the host form (`cxx <argv...>`), which the
// `cxx update` second pass needs so it syncs every installed engine.
func ReExecAfterUpdateAs(exe, engine string, argv []string) (err error) {
	if exe == "" {
		return errors.New("ReExecAfterUpdate: empty exe path")
	}
	full := layout.ReexecArgv(exe, engine, argv)
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

func SelfUpdateFrom(ctx context.Context, cfg *config.Config, binaryURL, binarySHA256, targetVersion string, logger *slog.Logger) (string, error) {
	return coreupdate.Install(ctx, cfg, binaryURL, binarySHA256, targetVersion, logger)
}

var SnapshottedArgv []string
