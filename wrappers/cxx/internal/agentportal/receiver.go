package agentportal

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Claude preserves its native TUI and user hooks. A temporary plugin reports
// the actual SessionStart identity, including continue, resume pickers and /clear.
// The broker owns this directory and removes it when the wrapper exits.
func ClaudeReceiverArgs(args []string) ([]string, error) {
	socket := os.Getenv(envSocket)
	if socket == "" {
		return args, fmt.Errorf("private broker unavailable")
	}
	binary, err := os.Executable()
	if err != nil {
		return args, err
	}
	plugin := filepath.Join(filepath.Dir(socket), "receiver-plugin")
	for _, dir := range []string{".claude-plugin", "hooks"} {
		if err := os.MkdirAll(filepath.Join(plugin, dir), 0700); err != nil {
			return args, err
		}
	}
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
	command := quote(binary) + " agent native-session"
	hook := map[string]any{"type": "command", "command": command, "timeout": 5}
	hooks := map[string]any{"hooks": map[string]any{"SessionStart": []any{map[string]any{"hooks": []any{hook}}}}}
	body, _ := json.Marshal(hooks)
	if err := os.WriteFile(filepath.Join(plugin, "hooks", "hooks.json"), body, 0600); err != nil {
		return args, err
	}
	if err := os.WriteFile(filepath.Join(plugin, ".claude-plugin", "plugin.json"), []byte(`{"name":"cxx-receiver","version":"1.0.0"}`), 0600); err != nil {
		return args, err
	}
	env := map[string]string{envSocket: socket, envSessionID: os.Getenv(envSessionID), envEngine: "claude"}
	mcp, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"cxx-agent": map[string]any{"command": binary, "args": []string{"agent", "mcp", "--auto"}, "env": env}}})
	out := append([]string{}, args...)
	return append(out, "--plugin-dir", plugin, "--mcp-config", string(mcp), "--dangerously-load-development-channels", "server:cxx-agent"), nil
}
