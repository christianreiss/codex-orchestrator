package agentbus

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
)

func TestHostInventoryUsesHostKeyAndSendsOnlyFilters(t *testing.T) {
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/host/agent-messaging/list" || r.Header.Get("X-API-Key") != "test-host-key" {
			t.Fatalf("unexpected host request: %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"scope": "host", "read_only": true, "host_id": 7, "addresses": []any{}})
	}))
	defer server.Close()
	cfg := &config.Config{Engine: "claude", Orchestrator: config.Orchestrator{BaseURL: server.URL, APIKey: "test-host-key"}}
	out, err := listHostWithConfig(context.Background(), cfg, "claude", false)
	if err != nil || out["scope"] != "host" {
		t.Fatalf("out=%v err=%v", out, err)
	}
	if got["engine"] != "claude" || got["include_offline"] != false || len(got) != 2 {
		t.Fatalf("body must carry only engine/include_offline filters: %v", got)
	}
}

func isolateHostConfig(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv(envSocket, "")
	t.Setenv(envSessionID, "")
	t.Setenv("XDG_CONFIG_HOME", dir)
	for _, name := range []string{"CDX_CONFIG_PATH", "CLX_CONFIG_PATH", "CGX_CONFIG_PATH"} {
		t.Setenv(name, "")
	}
	return dir
}

func TestAgentListOutsideLifecycleRefusesFleetFlagsAndNamesSearchedConfig(t *testing.T) {
	dir := isolateHostConfig(t)
	for _, args := range [][]string{{"--scope", "project"}, {"--host", "3"}, {"--limit", "5"}} {
		var stdout, stderr bytes.Buffer
		if code := RunCommand(append([]string{"list"}, args...), strings.NewReader(""), &stdout, &stderr, "test"); code != 1 {
			t.Fatalf("%v: code %d", args, code)
		}
		if !strings.Contains(stderr.String(), "host scope only") || stdout.Len() != 0 {
			t.Fatalf("%v: stderr %q", args, stderr.String())
		}
	}
	var stdout, stderr bytes.Buffer
	if code := RunCommand([]string{"list", "--scope", "host"}, strings.NewReader(""), &stdout, &stderr, "test"); code != 1 {
		t.Fatalf("missing config must fail, code %d", code)
	}
	if !strings.Contains(stderr.String(), filepath.Join(dir, "codex-orchestrator", "clx.json")) {
		t.Fatalf("error must name searched config paths: %q", stderr.String())
	}
	if strings.Contains(stderr.String(), "only inside a managed") {
		t.Fatalf("host path must not report the lifecycle refusal: %q", stderr.String())
	}
}

func TestAgentStatusOutsideLifecyclePointsAtHostInventory(t *testing.T) {
	isolateHostConfig(t)
	var stdout bytes.Buffer
	if err := runStatus(&stdout); err != nil {
		t.Fatal(err)
	}
	var status map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status["session_available"] != false || status["host_config_available"] != false {
		t.Fatalf("status %v", status)
	}
	if hint, _ := status["hint"].(string); !strings.Contains(hint, "cxx agent list") {
		t.Fatalf("hint %q", hint)
	}
	if _, err := sessionClientFromEnv(0); err == nil || !strings.Contains(err.Error(), "cxx agent list") {
		t.Fatalf("lifecycle refusal must point at the host inventory: %v", err)
	}
}
