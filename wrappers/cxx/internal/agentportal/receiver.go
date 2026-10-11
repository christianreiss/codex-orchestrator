package agentportal

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// PluginName is the directory and manifest name of the per-launch plugin the
// wrapper hands Claude. It is load-bearing twice over: Claude Code derives the
// plugin's source id from the directory basename (`<basename>@inline`), and it
// keys the plugin's MCP server as `plugin:<plugin>:<server>`, which becomes the
// `mcp__plugin_cxx-receiver_cxx-agent__<tool>` identifier permissions match on.
// Renaming it renames every messaging tool; keep it in step with
// CLAUDE_AGENT_MESSAGING_SERVER in api/src/services/agent-messaging-tool-names.ts.
const PluginName = "cxx-receiver"

// ChannelEntry is the plugin channel Claude is asked to register. `inline` is
// the sentinel marketplace Claude Code gives a --plugin-dir plugin.
//
// It must stay a `plugin:` entry. Claude Code resolves the alternative
// `server:<name>` form against the enterprise, managed, user, project and
// local MCP scopes only -- a server handed to it on the command line via
// --mcp-config is invisible to that check, and the channel is skipped with
// "no MCP server configured with that name" whatever else is passed. The
// fleet no longer writes a user-scope `mcpServers.cxx-agent` entry, so
// `server:cxx-agent` is now unresolvable by construction.
const ChannelEntry = "plugin:" + PluginName + "@inline"

// Claude preserves its native TUI and user hooks. A temporary plugin reports
// the actual SessionStart identity, including continue, resume pickers and
// /clear, and carries the `cxx-agent` MCP server itself.
//
// The server rides in the plugin rather than in a --mcp-config override because
// only a plugin-provided server can be registered as a channel from the
// approved-channels allowlist. A bare `server:` entry has no allowlist path at
// all in Claude Code and always demands the interactive
// --dangerously-load-development-channels confirmation. Managed settings then
// approve this plugin (see ensureChannelPolicy), so the confirmation never
// appears; without that policy the wrapper keeps the old prompting shape rather
// than registering a channel that would be silently skipped.
//
// The broker owns this directory and removes it when the wrapper exits.
func ClaudeReceiverArgs(args []string) ([]string, error) {
	return claudePluginArgs(args, true)
}

// ClaudeAgentArgs attaches the same plugin without the receiver: the `cxx-agent`
// tools and lifecycle failure hooks. Headless and piped launches take this path, because
// the fleet no longer renders a user-scope `cxx-agent` entry for Claude — the
// plugin is now the only thing that carries the server, so a session that skips
// it would have no messaging tools at all.
func ClaudeAgentArgs(args []string) ([]string, error) {
	return claudePluginArgs(args, false)
}

func claudePluginArgs(args []string, receiver bool) ([]string, error) {
	socket := os.Getenv(envSocket)
	if socket == "" {
		return args, fmt.Errorf("private broker unavailable")
	}
	binary, err := os.Executable()
	if err != nil {
		return args, err
	}
	plugin := filepath.Join(filepath.Dir(socket), PluginName)
	for _, dir := range []string{".claude-plugin", "hooks"} {
		if err := os.MkdirAll(filepath.Join(plugin, dir), 0700); err != nil {
			return args, err
		}
	}
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
	// Failure/exit evidence belongs to every managed launch. Only receiver
	// launches publish the native identity needed for channel registration.
	watchdogHook := map[string]any{"type": "command", "command": quote(binary) + " agent watchdog-event", "timeout": 5}
	hooks := map[string]any{
		"StopFailure": []any{map[string]any{"hooks": []any{watchdogHook}}},
		"SessionEnd":  []any{map[string]any{"hooks": []any{watchdogHook}}},
	}
	if receiver {
		command := quote(binary) + " agent native-session"
		hook := map[string]any{"type": "command", "command": command, "timeout": 5}
		hooks["SessionStart"] = []any{map[string]any{"hooks": []any{hook}}}
	}
	hooksBody, _ := json.Marshal(map[string]any{"hooks": hooks})
	if err := os.WriteFile(filepath.Join(plugin, "hooks", "hooks.json"), hooksBody, 0600); err != nil {
		return args, err
	}
	approved := receiver && ensureChannelPolicy()
	manifest := map[string]any{"name": PluginName, "version": "1.0.0"}
	serverArgs := []string{"agent", "mcp"}
	if receiver {
		manifest["channels"] = []any{map[string]any{"server": "cxx-agent"}}
		// An MCP pong does not prove that Claude admits channel notifications.
		// Keep tools usable during policy fallback, but leave automatic work queued.
		if approved {
			serverArgs = append(serverArgs, "--auto")
		}
	}
	body, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(plugin, ".claude-plugin", "plugin.json"), body, 0600); err != nil {
		return args, err
	}
	env := map[string]string{envSocket: socket, envSessionID: os.Getenv(envSessionID), envEngine: "claude"}
	mcp, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"cxx-agent": map[string]any{"command": binary, "args": serverArgs, "env": env}}})
	if err := os.WriteFile(filepath.Join(plugin, ".mcp.json"), mcp, 0600); err != nil {
		return args, err
	}
	out := append(append([]string{}, args...), "--plugin-dir", plugin)
	if !receiver {
		return out, nil
	}
	if approved {
		recordChannelPolicy(plugin, "approved")
		return append(out, "--channels", ChannelEntry), nil
	}
	recordChannelPolicy(plugin, "fallback")
	return append(out, "--dangerously-load-development-channels", ChannelEntry), nil
}

// ChannelPolicyMarker distinguishes approved push delivery from development
// fallback. Fallback retains manual MCP tools but never starts automatic work
// admission; the receiver checks the marker again before registering readiness.
const ChannelPolicyMarker = "channel-policy"

// recordChannelPolicy is best-effort: a write failure here must never fail
// the launch it is only annotating.
func recordChannelPolicy(plugin, status string) {
	_ = os.WriteFile(filepath.Join(plugin, ChannelPolicyMarker), []byte(status), 0600)
}
