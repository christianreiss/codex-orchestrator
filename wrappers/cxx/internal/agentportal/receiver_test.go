package agentportal

import (
	"encoding/json"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/nativewriter"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestClaudeReceiverPreservesResumeAndUserSettings(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(envSocket, filepath.Join(dir, "portal.sock"))
	t.Setenv(envSessionID, "session")
	t.Setenv(channelPolicyDirEnv, filepath.Join(dir, "managed"))
	args := []string{"--continue", "--settings", `{"hooks":{"SessionStart":[]}}`, "--plugin-dir", "user-plugin"}
	got, err := ClaudeReceiverArgs(args)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got[:len(args)], args) {
		t.Fatal("changed native arguments")
	}
	for _, arg := range got {
		if arg == "--session-id" {
			t.Fatal("invented an identity for a resumed session")
		}
	}
	data, err := os.ReadFile(filepath.Join(dir, PluginName, "hooks", "hooks.json"))
	if err != nil {
		t.Fatal(err)
	}
	var hooks map[string]any
	if err := json.Unmarshal(data, &hooks); err != nil {
		t.Fatal(err)
	}
	if hooks["hooks"].(map[string]any)["SessionStart"] == nil {
		t.Fatal("missing native identity hook")
	}
}

// The messaging server must ride inside the plugin, not in a --mcp-config
// override: only a plugin-provided server can be approved as a channel, which
// is what removes the development-channels confirmation.
func TestClaudeReceiverShipsServerInPluginAndTakesApprovedChannel(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(envSocket, filepath.Join(dir, "portal.sock"))
	t.Setenv(envSessionID, "session")
	t.Setenv(channelPolicyDirEnv, filepath.Join(dir, "managed"))
	got, err := ClaudeReceiverArgs(nil)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(got, " ")
	if strings.Contains(joined, "--mcp-config") {
		t.Fatal("server still injected outside the plugin")
	}
	if !strings.Contains(joined, "--channels "+ChannelEntry) {
		t.Fatalf("expected the approved channel entry: %v", got)
	}
	if strings.Contains(joined, "--dangerously-load-development-channels") {
		t.Fatalf("policy is installed; the confirmation must not be requested: %v", got)
	}
	var mcp struct {
		Servers map[string]struct {
			Args []string `json:"args"`
			Env  map[string]string
		} `json:"mcpServers"`
	}
	raw, err := os.ReadFile(filepath.Join(dir, PluginName, ".mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &mcp); err != nil {
		t.Fatal(err)
	}
	server, ok := mcp.Servers["cxx-agent"]
	if !ok {
		t.Fatalf("plugin does not provide cxx-agent: %s", raw)
	}
	if !reflect.DeepEqual(server.Args, []string{"agent", "mcp", "--auto"}) {
		t.Fatalf("receiver server args: %v", server.Args)
	}
	manifest, err := os.ReadFile(filepath.Join(dir, PluginName, ".claude-plugin", "plugin.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(manifest), `"channels"`) {
		t.Fatalf("manifest does not declare the channel: %s", manifest)
	}
	policy, err := os.ReadFile(filepath.Join(dir, "managed", "managed-settings.d", channelPolicyFile))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(policy), `"channelsEnabled":true`) || !strings.Contains(string(policy), PluginName) {
		t.Fatalf("drop-in does not approve the plugin: %s", policy)
	}
	marker, err := os.ReadFile(filepath.Join(dir, PluginName, ChannelPolicyMarker))
	if err != nil {
		t.Fatal(err)
	}
	if string(marker) != "approved" {
		t.Fatalf("expected doctor's marker to say approved, got %q", marker)
	}
}

// Without an approved channel the receiver must keep the old prompting shape.
// Registering a channel the gate silently skips would leave a receiver that
// reports healthy while nothing can reach the transcript.
func TestClaudeReceiverFallsBackWhenOrgPolicyOwnsChannels(t *testing.T) {
	dir := t.TempDir()
	managed := filepath.Join(dir, "managed")
	if err := os.MkdirAll(managed, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(managed, "managed-settings.json"), []byte(`{"channelsEnabled":false}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(envSocket, filepath.Join(dir, "portal.sock"))
	t.Setenv(envSessionID, "session")
	t.Setenv(channelPolicyDirEnv, managed)
	got, err := ClaudeReceiverArgs(nil)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(got, " ")
	if !strings.Contains(joined, "--dangerously-load-development-channels "+ChannelEntry) {
		t.Fatalf("expected the development-channel fallback: %v", got)
	}
	if strings.Contains(joined, "--channels ") {
		t.Fatalf("claimed an approved channel it does not have: %v", got)
	}
	if _, err := os.Stat(filepath.Join(managed, "managed-settings.d", channelPolicyFile)); !os.IsNotExist(err) {
		t.Fatal("wrote a drop-in over an organisation's own channel policy")
	}
	if strings.Contains(joined, "--mcp-config") {
		t.Fatalf("fallback reintroduced a command-line server: %v", got)
	}
	marker, err := os.ReadFile(filepath.Join(dir, PluginName, ChannelPolicyMarker))
	if err != nil {
		t.Fatal(err)
	}
	if string(marker) != "fallback" {
		t.Fatalf("expected doctor's marker to say fallback, got %q", marker)
	}
	raw, err := os.ReadFile(filepath.Join(dir, PluginName, ".mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	var mcp struct {
		Servers map[string]struct {
			Args []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &mcp); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(mcp.Servers["cxx-agent"].Args, []string{"agent", "mcp"}) {
		t.Fatalf("fallback auto-claims work despite no approved channel: %s", raw)
	}
}

// Claude Code resolves a `server:<name>` channel only against the enterprise,
// managed, user, project and local MCP scopes. A server passed on the command
// line is in none of them, and the fleet no longer writes a user-scope
// cxx-agent entry, so a bare `server:` entry can only ever be skipped with
// "no MCP server configured with that name". Both launch shapes must therefore
// name the plugin, never the server.
func TestChannelEntryNeverNamesABareServer(t *testing.T) {
	if strings.HasPrefix(ChannelEntry, "server:") {
		t.Fatalf("ChannelEntry must be a plugin entry, got %q", ChannelEntry)
	}
	dir := t.TempDir()
	t.Setenv(envSocket, filepath.Join(dir, "portal.sock"))
	t.Setenv(envSessionID, "session")
	t.Setenv(channelPolicyDirEnv, filepath.Join(dir, "managed"))
	for name, build := range map[string]func([]string) ([]string, error){
		"receiver": ClaudeReceiverArgs,
		"agent":    ClaudeAgentArgs,
	} {
		got, err := build(nil)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for _, arg := range got {
			if strings.HasPrefix(arg, "server:") {
				t.Fatalf("%s: unresolvable bare server channel %q in %v", name, arg, got)
			}
		}
	}
}

// Headless and piped launches still need the tools: the fleet no longer renders
// a user-scope cxx-agent entry for Claude, so the plugin is the only source.
func TestClaudeAgentArgsAttachPluginWithoutReceiver(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(envSocket, filepath.Join(dir, "portal.sock"))
	t.Setenv(envSessionID, "session")
	t.Setenv(channelPolicyDirEnv, filepath.Join(dir, "managed"))
	got, err := ClaudeAgentArgs(nil)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(got, " ")
	if !strings.Contains(joined, "--plugin-dir") {
		t.Fatalf("no plugin attached: %v", got)
	}
	if strings.Contains(joined, "--channels") || strings.Contains(joined, "development-channels") {
		t.Fatalf("a session with no receiver must not register a channel: %v", got)
	}
	raw, err := os.ReadFile(filepath.Join(dir, PluginName, ".mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "--auto") {
		t.Fatalf("started the receiver for a session that has none: %s", raw)
	}
}

func TestNativeIdentityIsLocalAndRequiresReceiverGrant(t *testing.T) {
	session := &Session{ID: "session", Engine: "claude", receiverAllowed: true}
	broker := &Broker{session: session}
	post := func(body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		broker.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/host/agent-sessions/session/receiver/native", strings.NewReader(body)))
		return recorder
	}
	if got := post(`{"native_session_id":"invalid"}`); got.Code != 400 {
		t.Fatalf("invalid identity: %d", got.Code)
	}
	const id = "11111111-1111-4111-8111-111111111111"
	if got := post(`{"native_session_id":"` + id + `"}`); got.Code != 200 {
		t.Fatalf("report: %d %s", got.Code, got.Body)
	}
	if got := post(`{}`); !strings.Contains(got.Body.String(), id) {
		t.Fatal("lost hook identity")
	}
	session.receiverAllowed = false
	if got := post(`{}`); got.Code != 403 {
		t.Fatalf("disabled grant: %d", got.Code)
	}
}

func TestDaemonChildUsesParentWriterOnlyForItsExactNativeIdentity(t *testing.T) {
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			t.Setenv("CXX_AGENT_MESSAGING_MESSAGE_ID", "")
			const id = "22222222-2222-4222-8222-222222222222"
			parent, err := nativewriter.Acquire(engine, id)
			if err != nil {
				t.Fatal(err)
			}
			defer parent.Release()
			broker := &Broker{session: &Session{ID: "session", Engine: engine, receiverAllowed: true}}
			post := func() *httptest.ResponseRecorder {
				response := httptest.NewRecorder()
				broker.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/host/agent-sessions/session/receiver/native", strings.NewReader(`{"native_session_id":"`+id+`"}`)))
				return response
			}
			if response := post(); response.Code != 409 {
				t.Fatalf("ordinary second writer was allowed: %d", response.Code)
			}
			t.Setenv("CXX_DAEMON_OPERATION_ID", "operation")
			t.Setenv("CXX_DAEMON_CLAIM_ID", "claim")
			t.Setenv("CXX_DAEMON_NATIVE_WRITER_ID", id)
			if response := post(); response.Code != 200 {
				t.Fatalf("parent-owned resume blocked: %d %s", response.Code, response.Body)
			}
			t.Setenv("CXX_DAEMON_NATIVE_WRITER_ID", "33333333-3333-4333-8333-333333333333")
			if response := post(); response.Code != 409 {
				t.Fatalf("unrelated native identity bypassed the writer lock: %d", response.Code)
			}
		})
	}
}

func TestClaudeHeadlessPluginRetainsFailureHooksWithoutReceiver(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(envSocket, filepath.Join(dir, "portal.sock"))
	t.Setenv(envSessionID, "session")
	if _, err := ClaudeAgentArgs(nil); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, PluginName, "hooks", "hooks.json"))
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Hooks map[string][]struct{ Hooks []struct{ Command string } }
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	for _, event := range []string{"StopFailure", "SessionEnd"} {
		hooks := parsed.Hooks[event]
		if len(hooks) != 1 || len(hooks[0].Hooks) != 1 || !strings.HasSuffix(hooks[0].Hooks[0].Command, " agent watchdog-event") {
			t.Fatalf("missing %s failure forwarding: %s", event, raw)
		}
	}
	if len(parsed.Hooks["SessionStart"]) != 0 {
		t.Fatal("headless plugin must not pretend to register a channel identity")
	}
}

// The activity and recovery changes both extend this one native hook map.
// A merge must preserve both commands on shared events without adding channel
// identity or activity reporting to headless launches.
func TestClaudePluginHooksCombineActivityAndFailureLifecycle(t *testing.T) {
	for _, receiver := range []bool{false, true} {
		name := "headless"
		if receiver {
			name = "receiver"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv(envSocket, filepath.Join(dir, "portal.sock"))
			t.Setenv(envSessionID, "session")
			t.Setenv(channelPolicyDirEnv, filepath.Join(dir, "managed"))
			var err error
			if receiver {
				_, err = ClaudeReceiverArgs(nil)
			} else {
				_, err = ClaudeAgentArgs(nil)
			}
			if err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(filepath.Join(dir, PluginName, "hooks", "hooks.json"))
			if err != nil {
				t.Fatal(err)
			}
			var parsed struct {
				Hooks map[string][]struct {
					Hooks []struct {
						Type, Command string
						Timeout       int
					}
				}
			}
			if err := json.Unmarshal(raw, &parsed); err != nil {
				t.Fatalf("invalid native hooks schema: %v: %s", err, raw)
			}
			expected := map[string][]string{
				"StopFailure": {"watchdog-event"},
				"SessionEnd":  {"watchdog-event"},
			}
			if receiver {
				expected["SessionStart"] = []string{"native-session"}
				for _, event := range []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Elicitation", "ElicitationResult", "Stop", "StopFailure", "SessionEnd"} {
					expected[event] = append(expected[event], "activity-event")
				}
			}
			if len(parsed.Hooks) != len(expected) {
				t.Fatalf("unexpected hook events: %s", raw)
			}
			for event, commands := range expected {
				entries := parsed.Hooks[event]
				if len(entries) != len(commands) {
					t.Fatalf("%s lost lifecycle hook: %s", event, raw)
				}
				for i, command := range commands {
					if len(entries[i].Hooks) != 1 {
						t.Fatalf("%s has invalid hook entries: %s", event, raw)
					}
					hook := entries[i].Hooks[0]
					if hook.Type != "command" || !strings.HasSuffix(hook.Command, " agent "+command) || hook.Timeout <= 0 {
						t.Fatalf("%s lost %s: %s", event, command, raw)
					}
				}
			}
		})
	}
}

// Claude spawns the plugin's MCP server and hooks with argv[0] = the rendered
// path; a clx alias (kept by os.Executable on macOS) rejects `agent ...`.
func TestClaudePluginCommandsUseCxxForPersonaAlias(t *testing.T) {
	dir := t.TempDir()
	bin := t.TempDir()
	canonical := filepath.Join(bin, "cxx")
	if err := os.WriteFile(canonical, []byte("cxx"), 0o755); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(bin, "clx")
	if err := os.Symlink("cxx", alias); err != nil {
		t.Fatal(err)
	}
	want, err := filepath.EvalSymlinks(canonical)
	if err != nil {
		t.Fatal(err)
	}
	prior := selfExecutable
	selfExecutable = func() (string, error) { return alias, nil }
	t.Cleanup(func() { selfExecutable = prior })
	t.Setenv(envSocket, filepath.Join(dir, "portal.sock"))
	t.Setenv(envSessionID, "session")
	t.Setenv(channelPolicyDirEnv, filepath.Join(dir, "managed"))
	if _, err := ClaudeReceiverArgs(nil); err != nil {
		t.Fatal(err)
	}
	var mcp struct {
		Servers map[string]struct {
			Command string `json:"command"`
		} `json:"mcpServers"`
	}
	raw, err := os.ReadFile(filepath.Join(dir, PluginName, ".mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &mcp); err != nil {
		t.Fatal(err)
	}
	if got := mcp.Servers["cxx-agent"].Command; got != want {
		t.Fatalf("MCP command %q, want %q", got, want)
	}
	hooks, err := os.ReadFile(filepath.Join(dir, PluginName, "hooks", "hooks.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(hooks), alias) || !strings.Contains(string(hooks), want+"' agent ") {
		t.Fatalf("hooks must invoke cxx, not the clx alias: %s", hooks)
	}
}
