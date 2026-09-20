package agentportal

import (
	"encoding/json"
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
