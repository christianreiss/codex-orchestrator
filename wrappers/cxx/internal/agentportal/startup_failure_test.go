package agentportal

import (
	"context"
	"errors"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	"os"
	"strings"
	"testing"
)

func TestStartupFailureSanitizesAndPreservesFirstStage(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "startup")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	t.Setenv(StartupFailureEnv, file.Name())
	recordStartupFailure("registration", &PortalError{Status: 409, Code: "agent_messaging_lease_lost", Message: "private-token-and-prompt"})
	recordStartupFailure("identity", errors.New("another private result"))
	if got := ReadStartupFailure(file); got != "startup stage=registration code=agent_messaging_lease_lost http=409" {
		t.Fatal(got)
	}
}

func TestStartupFailureNeverCopiesArbitraryFields(t *testing.T) {
	for _, raw := range []string{
		`{"stage":"registration","code":"secret-token","status":409}`,
		`{"stage":"private prompt","code":"failed"}`,
		`{"stage":"identity","code":"failed","status":200}`,
		strings.Repeat("x", 257),
	} {
		if got := ReadStartupFailure(strings.NewReader(raw)); got != "" {
			t.Fatalf("unsafe diagnostic: %q", got)
		}
	}
	file, err := os.CreateTemp(t.TempDir(), "startup")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	t.Setenv(StartupFailureEnv, file.Name())
	recordStartupFailure("registration", &PortalError{Status: 403, Code: "secret-token", Message: "private"})
	if got := ReadStartupFailure(file); got != "startup stage=registration code=api_rejected http=403" {
		t.Fatal(got)
	}
}

func TestIdentityRemovesDiagnosticCapabilityBeforeNativeLaunch(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "startup")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	t.Setenv(StartupFailureEnv, file.Name())
	runtime := &ConnectionRuntime{}
	_, err = runtime.RequireIdentity(context.Background(), &config.Config{AgentMessaging: config.AgentMessaging{Enabled: true}})
	if err == nil || os.Getenv(StartupFailureEnv) != "" {
		t.Fatal("startup diagnostic capability survived identity gate", err)
	}
	if got := ReadStartupFailure(file); got != "startup stage=identity code=failed" {
		t.Fatal(got)
	}
}

func TestSuccessfulIdentityClearsTransientStartupFailure(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "startup")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	t.Setenv(StartupFailureEnv, file.Name())
	recordStartupFailure("registration", errors.New("transient"))
	runtime := &ConnectionRuntime{}
	if _, err := runtime.RequireIdentity(context.Background(), &config.Config{}); err != nil {
		t.Fatal(err)
	}
	if got := ReadStartupFailure(file); got != "" {
		t.Fatal("recovered failure remained", got)
	}
	if os.Getenv(StartupFailureEnv) != "" {
		t.Fatal("capability survived successful gate")
	}
}
