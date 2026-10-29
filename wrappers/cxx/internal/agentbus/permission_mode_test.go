package agentbus

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestNativeArgsWithPermissionMode(t *testing.T) {
	for _, tc := range []struct {
		name, engine, upstream, model, mode string
		want                                []string
	}{
		{
			name: "claude plan first turn", engine: config.EngineClaude, mode: "plan",
			want: []string{"claude", "--skip-boot", "run", "-p", "--output-format", "json", "--permission-mode", "plan"},
		},
		{
			name: "claude plan resumed turn with model", engine: config.EngineClaude, upstream: "claude-session", model: "claude-opus-5-5", mode: "plan",
			want: []string{"claude", "--skip-boot", "resume", "claude-session", "-p", "--output-format", "json", "--model", "claude-opus-5-5", "--permission-mode", "plan"},
		},
		{
			name: "grok plan resumed turn", engine: config.EngineGrok, upstream: "grok-session", mode: "plan",
			want: []string{"grok", "--skip-boot", "run", "--no-leader", "--output-format", "json", "--resume", "grok-session", "--permission-mode", "plan"},
		},
		{
			name: "codex never gets a permission flag", engine: config.EngineCodex, upstream: "codex-session", mode: "plan",
			want: []string{"codex", "--skip-boot", "run", "exec", "resume", "--json", "--skip-git-repo-check", "codex-session", "-"},
		},
		{
			name: "default mode passes no flag", engine: config.EngineClaude, upstream: "claude-session", mode: "default",
			want: []string{"claude", "--skip-boot", "resume", "claude-session", "-p", "--output-format", "json"},
		},
		{
			name: "empty mode passes no flag", engine: config.EngineGrok,
			want: []string{"grok", "--skip-boot", "run", "--no-leader", "--output-format", "json"},
		},
		{
			name: "unknown mode is never forwarded", engine: config.EngineClaude, mode: "bypassPermissions",
			want: []string{"claude", "--skip-boot", "run", "-p", "--output-format", "json"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := nativeArgsWithPermissionMode(tc.engine, tc.upstream, tc.model, tc.mode)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("nativeArgsWithPermissionMode(%q, %q, %q, %q) = %v, want %v", tc.engine, tc.upstream, tc.model, tc.mode, got, tc.want)
			}
		})
	}
}

func TestDaemonOperationDecodesPermissionMode(t *testing.T) {
	var op daemonOperation
	if err := json.Unmarshal([]byte(`{"operation_id":"o","engine":"claude","permission_mode":"plan"}`), &op); err != nil {
		t.Fatal(err)
	}
	if op.PermissionMode != "plan" {
		t.Fatalf("permission mode = %q", op.PermissionMode)
	}
}

func TestHelloRejectsCapabilityOnlyForTheCapabilityField(t *testing.T) {
	strict := &daemonRejection{message: `[{"code":"unrecognized_keys","keys":["permission_mode_version"],"path":[],"message":"Unrecognized key(s) in object: 'permission_mode_version'"}]`}
	if !helloRejectsCapability(strict) {
		t.Fatal("an old server's strict-schema rejection must trigger the fallback hello")
	}
	if helloRejectsCapability(&daemonRejection{message: "Daemon service user does not match enabled host settings"}) {
		t.Fatal("unrelated rejections must not retry")
	}
	if helloRejectsCapability(errors.New("daemon request timed out permission_mode_version")) {
		t.Fatal("transport errors are not server rejections")
	}
}
