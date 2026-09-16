package remote

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func enabledPolicy(engine string) (*config.Config, error) {
	return &config.Config{Engine: engine, Remote: config.Remote{Enabled: true}}, nil
}

func disabledPolicy(engine string) (*config.Config, error) {
	return &config.Config{Engine: engine, Remote: config.Remote{Enabled: false}}, nil
}

func TestRequireEnabledFollowsSignedPolicy(t *testing.T) {
	previous := loadSignedConfig
	t.Cleanup(func() { loadSignedConfig = previous })

	loadSignedConfig = enabledPolicy
	if err := requireEnabled(); err != nil {
		t.Fatalf("enabled policy refused: %v", err)
	}

	loadSignedConfig = disabledPolicy
	err := requireEnabled()
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != CodeDenied {
		t.Fatalf("error = %v, want %s", err, CodeDenied)
	}
}

// TestRequireEnabledFailsClosedWithoutAConfig keeps an unreadable or missing
// signed config from reading as permission. The whole point of the switch is
// that a fleet which has not turned this on does not have it.
func TestRequireEnabledFailsClosedWithoutAConfig(t *testing.T) {
	previous := loadSignedConfig
	t.Cleanup(func() { loadSignedConfig = previous })
	loadSignedConfig = func(string) (*config.Config, error) {
		return nil, errors.New("no such file")
	}
	err := requireEnabled()
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != CodeDenied {
		t.Fatalf("error = %v, want %s", err, CodeDenied)
	}
	if !strings.Contains(typed.Message, "no such file") {
		t.Fatalf("message hides why it could not decide: %q", typed.Message)
	}
}

// TestSecondEngineAnswersWhenTheFirstIsAbsent covers the ordinary single-engine
// host: a Claude-only box has no codex config, and that must not read as a
// refusal.
func TestSecondEngineAnswersWhenTheFirstIsAbsent(t *testing.T) {
	previous := loadSignedConfig
	t.Cleanup(func() { loadSignedConfig = previous })
	loadSignedConfig = func(engine string) (*config.Config, error) {
		if engine == config.EngineCodex {
			return nil, errors.New("not installed")
		}
		return enabledPolicy(engine)
	}
	if err := requireEnabled(); err != nil {
		t.Fatalf("claude-only host refused: %v", err)
	}
}

func TestDisabledPolicyStopsEveryTargetVerb(t *testing.T) {
	previous := loadSignedConfig
	t.Cleanup(func() { loadSignedConfig = previous })
	loadSignedConfig = disabledPolicy

	for _, args := range [][]string{
		{"info", "--host", "build01"},
		{"exec", "--host", "build01", "--", "true"},
		{"ps", "--host", "build01"},
		{"push", "--host", "build01", "a", "b"},
	} {
		var stdout, stderr bytes.Buffer
		code := RunCommand(args, strings.NewReader(""), &stdout, &stderr, "test")
		if code != ExitError {
			t.Fatalf("%v exit = %d, want %d", args, code, ExitError)
		}
		var payload map[string]any
		if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
			t.Fatalf("%v stdout = %q", args, stdout.String())
		}
		if payload["code"] != CodeDenied {
			t.Fatalf("%v code = %v, want %s", args, payload["code"], CodeDenied)
		}
	}
}

// TestTargetVerbsSkipThePolicyGate is the load-bearing half. The machine on the
// far end of the connection is not a fleet host: it has no signed config, no
// API key and no engine. Applying the gate there would make the feature refuse
// itself the moment it arrived.
func TestTargetVerbsSkipThePolicyGate(t *testing.T) {
	previous := loadSignedConfig
	t.Cleanup(func() { loadSignedConfig = previous })
	loadSignedConfig = func(string) (*config.Config, error) {
		t.Fatal("the target half consulted signed host policy")
		return nil, nil
	}
	for _, verb := range []string{"agent-info", "job", "fs", "supervise"} {
		if !runsOnTarget(verb) {
			t.Fatalf("%q is not recognised as a target verb", verb)
		}
		var stdout, stderr bytes.Buffer
		code := RunCommand([]string{verb}, strings.NewReader(""), &stdout, &stderr, "test")
		if code != ExitError {
			t.Fatalf("%s exit = %d", verb, code)
		}
		var payload map[string]any
		if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
			t.Fatalf("%s stdout = %q", verb, stdout.String())
		}
		if payload["code"] != CodeNotImplemented {
			t.Fatalf("%s code = %v, want %s", verb, payload["code"], CodeNotImplemented)
		}
	}
}

// TestTargetEnvSkipsThePolicyGate covers the awkward case the verb list cannot:
// a target that happens to be a fleet host too, where its own policy has
// nothing to say about a connection somebody else already authorized.
func TestTargetEnvSkipsThePolicyGate(t *testing.T) {
	previous := loadSignedConfig
	t.Cleanup(func() { loadSignedConfig = previous })
	loadSignedConfig = disabledPolicy
	t.Setenv(targetEnv, "1")

	var stdout, stderr bytes.Buffer
	code := RunCommand([]string{"info", "--host", "build01"}, strings.NewReader(""), &stdout, &stderr, "test")
	var payload map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatalf("stdout = %q", stdout.String())
	}
	if payload["code"] != CodeNotImplemented {
		t.Fatalf("code = %v, want %s (exit %d)", payload["code"], CodeNotImplemented, code)
	}
}
