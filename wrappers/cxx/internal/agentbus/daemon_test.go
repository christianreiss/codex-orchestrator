package agentbus

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDaemonJournalSurvivesAmbiguousExecution(t *testing.T) {
	dir := t.TempDir()
	op := daemonOperation{ID: newUUID(), Claim: newUUID(), Session: newUUID(), Prompt: "task"}
	if err := saveDaemonJournal(dir, daemonJournal{Operation: op}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, op.ID+".json")
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal(info, err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var j daemonJournal
	if err := json.Unmarshal(body, &j); err != nil {
		t.Fatal(err)
	}
	if j.Result != nil || j.Operation.Claim != op.Claim {
		t.Fatal("pending acceptance must survive restart", j)
	}
	j.Result = &daemonResult{Status: "completed", Reply: "done"}
	if err := saveDaemonJournal(dir, j); err != nil {
		t.Fatal(err)
	}
	body, _ = os.ReadFile(path)
	if err := json.Unmarshal(body, &j); err != nil || j.Result.Reply != "done" {
		t.Fatal(j, err)
	}
}
func TestDaemonRejectsInvalidDirectoryBeforeSpawning(t *testing.T) {
	for _, cwd := range []string{"relative", filepath.Join(t.TempDir(), "missing")} {
		result := runDaemonOperation(context.Background(), daemonOperation{Cwd: cwd, Engine: "codex"})
		if result.Status != "failed" {
			t.Fatal(result)
		}
	}
}
func TestDaemonRejectsUnknownEngine(t *testing.T) {
	if result := runDaemonOperation(context.Background(), daemonOperation{Cwd: t.TempDir(), Engine: "shell"}); result.Status != "failed" {
		t.Fatal(result)
	}
}

func TestDaemonNativeAdaptersProduceResumableResults(t *testing.T) {
	original := daemonExecutable
	defer func() { daemonExecutable = original }()
	for engine, body := range map[string]string{
		"codex":  "{\"type\":\"thread.started\",\"thread_id\":\"native-1\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}",
		"claude": "{\"result\":\"hello\",\"session_id\":\"native-1\",\"subtype\":\"success\"}",
		"grok":   "{\"text\":\"hello\",\"sessionId\":\"native-1\",\"stopReason\":\"end_turn\"}",
	} {
		t.Run(engine, func(t *testing.T) {
			dir := t.TempDir()
			script := filepath.Join(dir, "native-fixture")
			probe := `if [ "$1" = grok ]; then
if [ -n "$(cat)" ]; then echo 'Grok stdin must be empty' >&2; exit 42; fi
found=false
while [ "$#" -gt 0 ]; do
 if [ "$1" = --prompt-file ]; then shift; [ "$(cat "$1")" = "hello

Session title: test" ] || exit 43; found=true; break; fi
 shift
done
[ "$found" = true ] || exit 45
else
 [ "$(cat)" = "hello

Session title: test" ] || exit 44
fi
`
			// Fixed fixture strings contain no shell metacharacters or credentials.
			if err := os.WriteFile(script, []byte("#!/bin/sh\n"+probe+"cat <<'RESULT'\n"+body+"\nRESULT\n"), 0700); err != nil {
				t.Fatal(err)
			}
			daemonExecutable = func() (string, error) { return script, nil }
			result := runDaemonOperation(context.Background(), daemonOperation{ID: newUUID(), Claim: newUUID(), Cwd: dir, Engine: engine, Prompt: "hello", Title: "test"})
			if result.Status != "completed" || result.Reply != "hello" || result.Upstream != "native-1" {
				t.Fatal(result)
			}
		})
	}
}

func TestDaemonWorkingDirectoryDefaultsToServiceHome(t *testing.T) {
	original := daemonExecutable
	t.Cleanup(func() { daemonExecutable = original })
	home := filepath.Join(t.TempDir(), "service home")
	if err := os.Mkdir(home, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	for engine, body := range map[string]string{
		"codex":  "{\"type\":\"thread.started\",\"thread_id\":\"native-home\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"ok\"}}",
		"claude": "{\"result\":\"ok\",\"session_id\":\"native-home\",\"subtype\":\"success\"}",
		"grok":   "{\"text\":\"ok\",\"sessionId\":\"native-home\",\"stopReason\":\"end_turn\"}",
	} {
		t.Run(engine, func(t *testing.T) {
			dir := t.TempDir()
			record := filepath.Join(dir, "cwd")
			t.Setenv("CXX_DAEMON_CWD_PROBE", record)
			script := filepath.Join(dir, "native-fixture")
			if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '%s\\n' \"$PWD\" > \"$CXX_DAEMON_CWD_PROBE\"\ncat <<'RESULT'\n"+body+"\nRESULT\n"), 0700); err != nil {
				t.Fatal(err)
			}
			daemonExecutable = func() (string, error) { return script, nil }
			for _, cwd := range []string{"", dir} {
				result := runDaemonOperation(context.Background(), daemonOperation{ID: newUUID(), Claim: newUUID(), Engine: engine, Cwd: cwd, Prompt: "probe"})
				if result.Status != "completed" {
					t.Fatal(result)
				}
				actual, err := os.ReadFile(record)
				if err != nil {
					t.Fatal(err)
				}
				want := cwd
				if want == "" {
					want = home
				}
				if strings.TrimSpace(string(actual)) != want {
					t.Fatalf("cwd=%q got=%q want=%q", cwd, actual, want)
				}
			}
		})
	}
	t.Setenv("HOME", "")
	if result := runDaemonOperation(context.Background(), daemonOperation{Engine: "codex"}); result.Status != "failed" || !strings.Contains(result.Reply, "home directory") {
		t.Fatal(result)
	}
}

func TestConfiguredDaemonReconciliation(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux service")
	}
	original := reconcileHostDaemon
	t.Cleanup(func() { reconcileHostDaemon = original })
	for _, engine := range []string{"codex", "claude", "grok"} {
		t.Run(engine, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			fixture := config.Config{SchemaVersion: 1, Engine: engine, IssuedAt: "2026-10-11T00:00:00Z",
				Orchestrator:   config.Orchestrator{BaseURL: "https://example.test", APIKey: "test-key", InstallationID: "test"},
				Host:           config.Host{ID: 1, FQDN: "example.test", Secure: true},
				Wrapper:        config.Wrapper{Version: "test", BinaryURL: "https://example.test/cxx", BinarySHA256: strings.Repeat("0", 64)},
				AgentMessaging: config.AgentMessaging{Enabled: true, RelayPollSeconds: 25, QueuedTTLSeconds: 86400},
			}
			body, _ := json.Marshal(fixture)
			if err := os.WriteFile(path, body, 0600); err != nil {
				t.Fatal(err)
			}
			cfg, err := config.LoadForEngine(path, nil, true, engine)
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			reconcileHostDaemon = func(stdout, stderr io.Writer) error { calls++; return errors.New("installation pending") }
			var out bytes.Buffer
			ReconcileConfiguredHostDaemon(cfg, &out)
			if calls != 1 || !strings.Contains(out.String(), "installation pending") {
				t.Fatalf("calls=%d output=%s", calls, &out)
			}
			cfg.AgentMessaging.Enabled = false
			ReconcileConfiguredHostDaemon(cfg, &out)
			cfg.AgentMessaging.Enabled = true
			for _, key := range []string{"CXX_DAEMON_OPERATION_ID", "CXX_AGENT_MESSAGING_MESSAGE_ID"} {
				t.Setenv(key, "owned-work")
				ReconcileConfiguredHostDaemon(cfg, &out)
				t.Setenv(key, "")
			}
			if calls != 1 {
				t.Fatal("disabled messaging or accepted work managed its parent service", calls)
			}
		})
	}
}
