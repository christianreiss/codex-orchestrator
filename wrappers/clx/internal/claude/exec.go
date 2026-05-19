package claude

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"

	"github.com/christianreiss/codex-orchestrator/wrappers/clx/internal/config"
)

// FindCLI locates the upstream `claude` binary (override via $CLX_CLAUDE_BIN).
// Falls back to `claude-code` if `claude` is missing.
func FindCLI() (string, error) {
	if v := strings.TrimSpace(os.Getenv("CLX_CLAUDE_BIN")); v != "" {
		if _, err := os.Stat(v); err == nil {
			return v, nil
		}
		return "", fmt.Errorf("CLX_CLAUDE_BIN points at %q which is not accessible", v)
	}
	for _, name := range []string{"claude", "claude-code"} {
		if path, err := exec.LookPath(name); err == nil {
			return path, nil
		}
	}
	return "", errors.New("claude CLI not found on PATH (install it or set CLX_CLAUDE_BIN)")
}

func Run(ctx context.Context, cfg *config.Config, args []string) (int, error) {
	cli, err := FindCLI()
	if err != nil {
		return 127, err
	}
	teardown, _ := PreExec(ctx, cfg)
	defer teardown()
	cmd := exec.CommandContext(ctx, cli, args...)
	cmd.Env = BuildEnv(cfg)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return 127, fmt.Errorf("start claude: %w", err)
	}

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
