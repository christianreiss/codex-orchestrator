package codex

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"

	"github.com/christianreiss/codex-orchestrator/wrappers/cdx/internal/config"
)

// FindCLI locates the upstream `codex` binary on PATH (override via $CDX_CODEX_BIN).
func FindCLI() (string, error) {
	if v := strings.TrimSpace(os.Getenv("CDX_CODEX_BIN")); v != "" {
		if _, err := os.Stat(v); err == nil {
			return v, nil
		}
		return "", fmt.Errorf("CDX_CODEX_BIN points at %q which is not accessible", v)
	}
	path, err := exec.LookPath("codex")
	if err != nil {
		return "", errors.New("codex CLI not found on PATH (install it or set CDX_CODEX_BIN)")
	}
	return path, nil
}

// Run execs `codex` with the wrapper's prepared env. Signals are forwarded
// and the child's exit status is propagated. The returned int is the exit code.
//
// Side effects:
//   - Adds the current cwd to ~/.codex/config.toml under [projects.…] trust_level=trusted.
//   - Exports OTEL_* env vars derived from the [otel] block in config.toml.
//   - Starts an IPv4-forcing local proxy when CODEX_FORCE_IPV4=1.
//   - Selects a model/profile based on lane preference when neither is given.
func Run(ctx context.Context, cfg *config.Config, args []string) (int, error) {
	cli, err := FindCLI()
	if err != nil {
		return 127, err
	}

	teardown, _ := PreExec(ctx, cfg)
	defer teardown()

	args = applyLaneAndProfile(cfg, args)

	cmd := exec.CommandContext(ctx, cli, args...)
	cmd.Env = BuildEnv(cfg)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return 127, fmt.Errorf("start codex: %w", err)
	}

	// Forward signals to the child until it exits.
	sigCh := make(chan os.Signal, 4)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		for s := range sigCh {
			if cmd.Process != nil {
				_ = cmd.Process.Signal(s)
			}
		}
	}()

	waitErr := cmd.Wait()
	signal.Stop(sigCh)
	close(sigCh)

	if waitErr == nil {
		return 0, nil
	}
	if exitErr, ok := waitErr.(*exec.ExitError); ok {
		return exitErr.ExitCode(), nil
	}
	return 1, waitErr
}
