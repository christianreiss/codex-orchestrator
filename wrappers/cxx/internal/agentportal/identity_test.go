package agentportal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestIdentityProviderProcess(t *testing.T) {
	if os.Getenv("CXX_TEST_IDENTITY_PROVIDER") != "1" {
		return
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"args": os.Args, "name": os.Getenv(envLaunchName)})
	os.Exit(0)
}

func TestIdentityGateAndProviderContextAcrossEngines(t *testing.T) {
	const uuid = "12345678-1234-4123-8123-123456789abc"
	for _, engine := range []string{"codex", "claude", "grok"} {
		for _, resumed := range []bool{false, true} {
			for _, failure := range []string{"", "offline", "disabled", "unnamed", "foreign", "wrong-name", "self-offline", "exhausted"} {
				t.Run(engine+"/resume="+map[bool]string{true: "yes", false: "no"}[resumed]+"/"+failure, func(t *testing.T) {
					t.Setenv("CODEX_HOME", t.TempDir())
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.URL.Path == "/host/agent-sessions" {
							var body map[string]any
							_ = json.NewDecoder(r.Body).Decode(&body)
							if body["adapter_capabilities"].(map[string]any)["launch_identity_version"] != float64(1) {
								t.Error("missing identity capability")
							}
							if failure == "offline" || failure == "exhausted" {
								w.WriteHeader(503)
								_, _ = w.Write([]byte(`{"code":"agent_name_pool_exhausted"}`))
								return
							}
							name := "Claudia"
							if failure == "unnamed" {
								name = ""
							}
							_ = json.NewEncoder(w).Encode(map[string]any{"enabled": failure != "disabled", "session_id": body["session_id"], "bridge_token": body["bridge_token"], "agent_address": map[string]any{"name": name, "address": "agent:" + uuid, "binding_generation": 1}})
							return
						}
						if strings.HasSuffix(r.URL.Path, "/self") {
							if r.Header.Get("X-Agent-Bridge-Token") == "" || r.Header.Get("X-API-Key") != "" {
								t.Error("self is not bridge scoped")
							}
							if failure == "self-offline" {
								w.WriteHeader(503)
								return
							}
							id := strings.Split(r.URL.Path, "/")[3]
							name := "Claudia"
							if failure == "foreign" {
								id = "foreign"
							}
							if failure == "wrong-name" {
								name = "Tanja"
							}
							_ = json.NewEncoder(w).Encode(Identity{Version: 1, Name: name, UUID: uuid, Address: "agent:" + uuid, SessionID: id, Engine: engine})
							return
						}
						_, _ = w.Write([]byte(`{}`))
					}))
					defer server.Close()
					cfg := &config.Config{Engine: engine, Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-host-key"}, AgentMessaging: config.AgentMessaging{Enabled: true}}
					runtime, _ := StartConnection(context.Background(), cfg, StartInput{Engine: engine, Resumed: resumed})
					defer runtime.Close("completed", "test")
					identity, err := runtime.RequireIdentity(context.Background(), cfg)
					if failure != "" {
						if err == nil {
							t.Fatal("unconfirmed identity admitted a native launch")
						}
						return
					}
					if err != nil {
						t.Fatal(err)
					}
					args := []string{"--", "Keep this user prompt"}
					if engine == "codex" {
						args = append([]string{"exec"}, args...)
					}
					args, err = AppendIdentityArgs(engine, args, identity)
					if err != nil {
						t.Fatal(err)
					}
					// A separate process receives argv/env: no test-only prompt files or shared context writes.
					cmd := exec.Command(os.Args[0], append([]string{"-test.run=^TestIdentityProviderProcess$", "--"}, args...)...)
					cmd.Env = append(os.Environ(), "CXX_TEST_IDENTITY_PROVIDER=1")
					out, err := cmd.Output()
					if err != nil {
						t.Fatal(err)
					}
					var child struct {
						Args []string `json:"args"`
						Name string   `json:"name"`
					}
					if err = json.Unmarshal(out, &child); err != nil {
						t.Fatal(err)
					}
					context := strings.Join(child.Args, " ")
					for _, value := range []string{"Claudia", uuid, runtime.Session().ID, "agent_self", "Keep this user prompt"} {
						if !strings.Contains(context, value) {
							t.Fatalf("child context missing %s", value)
						}
					}
					if child.Name != "Claudia" {
						t.Fatal("child launch name missing")
					}
				})
			}
		}
	}
}

func TestMessagingDisabledDoesNotRequireIdentity(t *testing.T) {
	var runtime *ConnectionRuntime
	identity, err := runtime.RequireIdentity(context.Background(), &config.Config{})
	if err != nil || identity.Name != "" {
		t.Fatalf("disabled identity=%v err=%v", identity, err)
	}
	args := []string{"unchanged"}
	got, err := AppendIdentityArgs("codex", args, identity)
	if err != nil || len(got) != 1 || got[0] != "unchanged" {
		t.Fatal("local-only argv changed")
	}
}

func TestRecoveryKeepsNameAndRejectsIdentityReplacement(t *testing.T) {
	for _, name := range []string{"Claudia", "Tanja"} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				_ = json.NewEncoder(w).Encode(map[string]any{"enabled": true, "session_id": body["session_id"], "bridge_token": body["bridge_token"], "agent_address": map[string]any{"name": name, "address": "agent:12345678-1234-4123-8123-123456789abc", "binding_generation": 2}})
			}))
			defer server.Close()
			session := &Session{ID: newUUID(), BridgeToken: "test-token", LaunchName: "Claudia", BaseURL: server.URL, hostAPIKey: "host-key", http: server.Client(), registrationGeneration: 1, registrationBody: map[string]any{}}
			session.registrationBody["session_id"], session.registrationBody["bridge_token"] = session.ID, session.BridgeToken
			err := session.recoverRegistration(context.Background(), 1, false)
			if name == "Claudia" {
				if err != nil || session.registrationGeneration != 2 {
					t.Fatalf("same-launch recovery failed: %v", err)
				}
			} else if !portalErrorCode(err, "agent_identity_conflict") || !isTerminalBridgeError(err) {
				t.Fatalf("replacement accepted: %v", err)
			}
			if session.LaunchName != "Claudia" {
				t.Fatal("recovery changed the confirmed name")
			}
		})
	}
}
