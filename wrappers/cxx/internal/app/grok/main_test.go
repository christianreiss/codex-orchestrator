package grok

import (
	"bytes"
	"context"
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
