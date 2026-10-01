package grok

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/accountpool"
	"github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/config"
	native "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/grok"
	orchestrator "github.com/christianreiss/codex-orchestrator/wrappers/cxx/internal/persona/codex/orchestrator"
	"github.com/pelletier/go-toml"
)

func TestNativeFlagsRemainNative(t *testing.T) {
	for _, args := range [][]string{{"-m", "grok-4.6", "--reasoning-effort", "xhigh"}, {"-r", "session"}, {"-s", "new-session"}, {"-p", "literal-prompt", "--output-format", "json"}, {"--minimal"}, {"--no-leader", "--prompt-file", "prompt.txt"}} {
		o, err := parse(args)
		if err != nil {
			t.Fatal(err)
		}
		if o.command != "run" || len(o.args) != len(args) {
			t.Fatalf("native arguments consumed: %v => %+v", args, o)
		}
		for i, arg := range args {
			if o.args[i] != arg {
				t.Fatalf("native argument %d changed", i)
			}
		}
	}
}
func TestSyncFlagsAfterCommandAndResumeMapping(t *testing.T) {
	o, err := parse([]string{"sync", "--minimal", "--allow-concurrent-sync"})
	if err != nil {
		t.Fatal(err)
	}
	if o.command != "sync" || !o.skipBoot || !o.concurrent || len(o.args) != 0 {
		t.Fatalf("host sync flags lost: %+v", o)
	}
	o, err = parse([]string{"resume", "uuid", "--model", "grok-4.6"})
	if err != nil {
		t.Fatal(err)
	}
	if len(o.args) != 4 || o.args[0] != "--resume" || o.args[1] != "uuid" {
		t.Fatalf("resume mapping=%v", o.args)
	}
}
func TestWrapperVersionDoesNotRequireConfiguration(t *testing.T) {
	t.Setenv("CGX_CONFIG_PATH", "/fixture/missing/cgx.json")
	var out, errout bytes.Buffer
	if code := Run([]string{"-W"}, &out, &errout); code != 0 {
		t.Fatalf("version failed: %s", errout.String())
	}
	if out.Len() == 0 || errout.Len() != 0 {
		t.Fatal("wrapper version did not produce clean stdout")
	}
}

func TestSyncManagedConsumesBootstrapDocumentsAndOwnedPaths(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	home := filepath.Join(t.TempDir(), "native")
	t.Setenv("GROK_HOME", home)
	localConfig := []byte("[models]\nuser_setting='keep'\n[mcp_servers.mine]\ncommand='user-tool'\n")
	if err := native.AtomicWrite(filepath.Join(home, "config.toml"), localConfig, 0o600); err != nil {
		t.Fatal(err)
	}
	auth := []byte("original native credentials must stay untouched\n")
	if err := native.AtomicWrite(filepath.Join(home, "auth.json"), auth, 0o600); err != nil {
		t.Fatal(err)
	}
	const agents = "# Fleet instructions\nRead skills through MCP.\n"
	bootstrapCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/sync/bootstrap":
			var request orchestrator.BundleRequest
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
			}
			if request.Engine != "grok" || request.IncludeAuth || request.Home != home {
				t.Errorf("bootstrap request = %+v", request)
			}
			bootstrapCalls++
			body := "[models]\ndefault='grok-4.6'\n"
			owned := []string{"models.default"}
			if bootstrapCalls == 1 {
				body += "default_reasoning_effort='high'\n"
				owned = append(owned, "models.default_reasoning_effort")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "data": map[string]any{
				"status": "ok",
				"agents": map[string]any{"status": "updated", "version_id": 3, "content": agents},
				"config": map[string]any{"status": "updated", "version_id": 4, "content": body, "owned_paths": owned},
			}})
		case "/skills", "/host/users":
			_, _ = w.Write([]byte(`{"status":"ok","data":{}}`))
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	cfg := &config.Config{Engine: config.EngineGrok}
	cfg.Host.EnginesList = []string{config.EngineGrok}
	for i := 0; i < 2; i++ {
		if err := syncManaged(context.Background(), cfg, client); err != nil {
			t.Fatalf("managed sync %d: %v", i+1, err)
		}
	}
	actualAgents, err := os.ReadFile(filepath.Join(home, "AGENTS.md"))
	if err != nil || string(actualAgents) != agents {
		t.Fatalf("synced instructions = %q, %v", actualAgents, err)
	}
	actualAuth, err := os.ReadFile(filepath.Join(home, "auth.json"))
	if err != nil || !bytes.Equal(actualAuth, auth) {
		t.Fatal("content sync changed the native login")
	}
	raw, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	tree, err := toml.LoadBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	if tree.Get("models.default") != "grok-4.6" || tree.Get("models.user_setting") != "keep" || tree.Get("mcp_servers.mine.command") != "user-tool" {
		t.Fatalf("managed model or user settings lost: %s", raw)
	}
	if tree.Get("models.default_reasoning_effort") != nil {
		t.Fatal("retired fleet path survived bootstrap owned_paths reconciliation")
	}
}

func TestUninstallRefusesActiveOriginalHomeBeforeRemoteMutation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	base := filepath.Join(t.TempDir(), "native")
	t.Setenv("GROK_HOME", base)
	pool := accountpool.Load("grok", filepath.Join(base, "auth.json"), "https://fixture.invalid")
	runtime, err := native.NewRuntime(base, &config.Config{}, nil, pool)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; w.WriteHeader(500) }))
	defer server.Close()
	client := &orchestrator.Client{BaseURL: server.URL, HTTP: server.Client()}
	if err := uninstall(context.Background(), &config.Config{}, client); err == nil || !strings.Contains(err.Error(), "another cgx process") {
		t.Fatalf("uninstall=%v", err)
	}
	if called {
		t.Fatal("uninstall mutated server before active-home guard")
	}
	if _, err := os.Stat(runtime.Home); err != nil {
		t.Fatal("active managed home removed")
	}
}
