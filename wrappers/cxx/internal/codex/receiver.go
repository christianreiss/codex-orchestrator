package codex

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/ipc"
)

// The native TUI and receive adapter share this one app-server process. Its
// private socket lives beside the already protected portal broker socket.
func startReceiverServer(ctx context.Context, binary string, args, env []string, session *AuthSession, lease *ipc.Lock) ([]string, func(), error) {
	for _, arg := range args {
		if arg == "--remote" || strings.HasPrefix(arg, "--remote=") {
			return args, func() {}, fmt.Errorf("existing remote endpoint owns the native session")
		}
	}
	broker := os.Getenv("CXX_AGENT_PORTAL_SOCKET")
	if broker == "" {
		return args, func() {}, fmt.Errorf("private broker unavailable")
	}
	socket := filepath.Join(filepath.Dir(broker), "codex.sock")
	serverArgs := []string{"app-server", "--listen", "unix://" + socket}
	// MCP per-lifecycle overrides and engine configuration must be identical on
	// the server and TUI. Prompt text and interactive flags stay with the TUI.
	for i := 0; i < len(args); i++ {
		if args[i] == "--" {
			break
		}
		if (args[i] == "-c" || args[i] == "--config") && i+1 < len(args) {
			serverArgs = append(serverArgs, args[i], args[i+1])
			i++
		}
		if strings.HasPrefix(args[i], "--config=") {
			serverArgs = append(serverArgs, args[i])
		}
	}
	wrapper, err := os.Executable()
	if err != nil {
		return args, func() {}, err
	}
	overrides := []string{"-c", "mcp_servers.cxx-agent.command=" + strconv.Quote(wrapper), "-c", `mcp_servers.cxx-agent.args=["agent","mcp","--auto"]`,
		"-c", "mcp_servers.cxx-agent.env.CXX_CODEX_SOCKET=" + strconv.Quote(socket)}
	serverArgs = append(serverArgs, overrides...)
	serverCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(serverCtx, binary, serverArgs...)
	cmd.Env = env
	// Bounded diagnostics without copying conversations or prompts to a log.
	diagnostic := newRingBuffer(4096)
	cmd.Stderr = diagnostic
	closeFiles, err := AttachAuthLeaseFiles(cmd, session, lease)
	if err != nil {
		cancel()
		return args, func() {}, err
	}
	if err = cmd.Start(); err != nil {
		cancel()
		_ = closeFiles()
		return args, func() {}, err
	}
	_ = closeFiles()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	cleanup := func() { cancel(); <-done; _ = os.Remove(socket) }
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case err := <-done:
			cancel()
			return args, func() {}, fmt.Errorf("native receiver server exited: %w", err)
		case <-deadline.C:
			cleanup()
			return args, func() {}, fmt.Errorf("native receiver server did not open its socket")
		case <-ctx.Done():
			cleanup()
			return args, func() {}, ctx.Err()
		case <-tick.C:
			if _, err := os.Stat(socket); err == nil {
				out := append([]string{"--remote", "unix://" + socket}, args...)
				return out, cleanup, nil
			}
		}
	}
}
