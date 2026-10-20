package codexapp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/codex"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestConversationCommandsRegisterBeforeStartingProvider(t *testing.T) {
	for _, argv := range [][]string{{"run"}, {"exec"}, {"e", "hello"}, {"review", "--uncommitted"}, {"fork", "--last"}} {
		for _, registered := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/registered=%v", argv[0], registered), func(t *testing.T) {
				home := t.TempDir()
				t.Setenv("HOME", home)
				t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
				t.Setenv("XDG_RUNTIME_DIR", filepath.Join(home, "run"))
				marker := filepath.Join(home, "provider-started")
				t.Setenv("CXX_TEST_SESSION_MARKER", marker)
				cli := filepath.Join(home, "vendor-codex")
				if err := os.WriteFile(cli, []byte("#!/bin/sh\nprintf '%s\\n' \"$CXX_AGENT_NAME\" \"$@\" > \"$CXX_TEST_SESSION_MARKER\"\n"), 0700); err != nil {
					t.Fatal(err)
				}
				t.Setenv("CDX_CODEX_BIN", cli)
				payload := json.RawMessage(fmt.Sprintf(`{"last_refresh":%q,"tokens":{"access_token":"fixture-access","refresh_token":"fixture-refresh"}}`, time.Now().UTC().Format(time.RFC3339Nano)))
				if err := codex.WriteAuth(payload); err != nil {
					t.Fatal(err)
				}
				var registrations atomic.Int32
				const uuid = "12345678-1234-4123-8123-123456789abc"
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					switch {
					case r.URL.Path == "/sync/bootstrap":
						_, _ = w.Write([]byte(`{"auth":{"status":"valid","verification_state":"verified","host":{"secure":true,"engines_list":["codex"]}}}`))
					case r.URL.Path == "/skills":
						_, _ = w.Write([]byte(`{"skills":[]}`))
					case r.URL.Path == "/host/agent-sessions":
						registrations.Add(1)
						if !registered {
							w.WriteHeader(http.StatusForbidden)
							_, _ = w.Write([]byte(`{"code":"fixture_registration_denied"}`))
							return
						}
						var body map[string]any
						_ = json.NewDecoder(r.Body).Decode(&body)
						_ = json.NewEncoder(w).Encode(map[string]any{"enabled": true, "session_id": body["session_id"], "bridge_token": body["bridge_token"], "agent_address": map[string]any{"name": "Fixture", "address": "agent:" + uuid, "binding_generation": 1}})
					case strings.HasSuffix(r.URL.Path, "/self"):
						_ = json.NewEncoder(w).Encode(map[string]any{"identity_version": 1, "name": "Fixture", "uuid": uuid, "address": "agent:" + uuid, "session_id": strings.Split(r.URL.Path, "/")[3], "engine": "codex"})
					default:
						_, _ = w.Write([]byte(`{}`))
					}
				}))
				defer server.Close()
				cfg := &config.Config{Engine: "codex", Host: config.Host{Secure: true, EnginesList: []string{"codex"}}, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "fixture"}, AgentMessaging: config.AgentMessaging{Enabled: true}}
				f, positional, passthrough := invocationFlags(argv, false)
				f.skipBoot = true
				sub, rest := resolveCommand(f, positional)
				launchArgs, ok := sessionCommandArgs(sub, rest, passthrough)
				if !ok {
					t.Fatalf("conversation %q bypasses registration", argv)
				}
				exit, err := cmdSession(context.Background(), cfg, f, slog.New(slog.DiscardHandler), launchArgs)
				if registrations.Load() != 1 {
					t.Fatalf("registrations = %d, want 1; exit=%d err=%v", registrations.Load(), exit, err)
				}
				raw, readErr := os.ReadFile(marker)
				if !registered {
					if exit == 0 || err == nil || !os.IsNotExist(readErr) {
						t.Fatalf("unregistered provider started: exit=%d err=%v marker=%q readErr=%v", exit, err, raw, readErr)
					}
					return
				}
				if exit != 0 || err != nil || readErr != nil {
					t.Fatalf("registered launch = %d, %v; provider=%q readErr=%v", exit, err, raw, readErr)
				}
				if !strings.HasPrefix(string(raw), "Fixture\n") || !strings.Contains(string(raw), "your name is Fixture") {
					t.Fatalf("provider received no managed identity: %q", raw)
				}
				if argv[0] == "e" || argv[0] == "review" || argv[0] == "fork" {
					if !strings.Contains(string(raw), "\n"+argv[0]+"\n") {
						t.Fatalf("native conversation command disappeared: %q", raw)
					}
				}
			})
		}
	}
}

func TestRawExecKeepsNativeArgumentsAndRejectsUnsupervisedServices(t *testing.T) {
	for _, argv := range [][]string{{"exec", "--", "exec", "--json", "hello"}, {"exec", "--", "app-server"}} {
		f, positional, passthrough := invocationFlags(argv, false)
		sub, rest := resolveCommand(f, positional)
		args, ok := sessionCommandArgs(sub, rest, passthrough)
		if ok != (argv[2] == "exec") || strings.Join(args, "\n") != strings.Join(argv[2:], "\n") {
			t.Fatalf("raw exec grammar changed: %q -> %q", argv, args)
		}
		if argv[2] == "app-server" {
			var stdout, stderr strings.Builder
			if exit := Run(argv, &stdout, &stderr); exit != 2 || !strings.Contains(stderr.String(), "separate managed auth/session lifecycle") {
				t.Fatalf("raw exec bypassed unsupported-service gate: exit=%d stderr=%s", exit, stderr.String())
			}
		}
	}
}

func TestRawExecUtilitiesDoNotAcquireConversationIdentity(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"-h"}, {"--version"}, {"-V"}, {"exec", "--help"}, {"--model", "fixture", "--version"}, {"login", "status"}, {"logout"}, {"completion", "bash"}, {"features", "list"}, {"apply", "task-id"}, {"mcp", "list"}, {"--model", "fixture", "login", "status"}} {
		argv := append([]string{"exec", "--"}, args...)
		f, positional, passthrough := invocationFlags(argv, false)
		sub, rest := resolveCommand(f, positional)
		got, conversation := sessionCommandArgs(sub, rest, passthrough)
		if conversation || strings.Join(got, "\n") != strings.Join(args, "\n") {
			t.Fatalf("raw utility acquired identity or changed arguments: %q -> %q (conversation=%v)", argv, got, conversation)
		}
	}
	for _, args := range [][]string{nil, {"hello"}, {"exec", "hello"}, {"e", "hello"}, {"review"}, {"resume", "--last"}, {"fork", "--last"}, {"--model", "--help"}, {"--model", "-V"}, {"--", "--help"}, {"exec", "--", "--version"}} {
		if _, conversation := sessionCommandArgs("exec", nil, args); !conversation {
			t.Fatalf("raw conversation bypassed identity: %q", args)
		}
	}
}
